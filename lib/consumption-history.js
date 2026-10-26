const {toFluxValue} = require('@influxdata/influxdb-client');

// Devices write their power only when it changes (advanced mode), so the
// power a device had at the start of a range is its last value before it.
const DEVICE_LOOKBACK_MS = 7 * 24 * 3600 * 1000;

// Fetch the meter and pack flows together. SOC rows preserve timestamps where
// the battery reports no power fields, so missing telemetry stays unavailable.
function createConsumptionHistory({queryApi, config}) {
    function request(range, every) {
        return new Promise((resolve, reject) => {
            const data = {power1: [], power2: [], battery: []};
            const batteryRows = new Map();
            const batteryCounts = new Map();
            const source = `from(bucket: ${toFluxValue(config.influx_bucket)})
                |> range(${range})
                |> filter(fn: (r) => r["home"] == ${toFluxValue(config.influx_default_tag)})
                |> filter(fn: (r) =>
                    (r["_measurement"] == "power" and (r["_field"] == "power1" or r["_field"] == "power2")) or
                    (r["_measurement"] == "battery" and (r["_field"] == "socPercent" or r["_field"] == "packInputPower" or r["_field"] == "outputPackPower")))`;
            // Compare each power field's sample count with SOC, which the
            // battery writer always stores. Means must not hide missing fields.
            const query = every ? `readings = ${source}
                readings
                    |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
                    |> sort(columns: ["_time"], desc: false)
                    |> yield(name: "mean")
                readings
                    |> filter(fn: (r) => r["_measurement"] == "battery")
                    |> aggregateWindow(every: ${every}, fn: count, createEmpty: false)
                    |> yield(name: "battery_counts")` : `${source}
                |> sort(columns: ["_time"], desc: false)`;

            queryApi.queryRows(query, {
                next(row, tableMeta) {
                    const field = tableMeta.column('_field').get(row);
                    const time = tableMeta.column('_time').get(row);
                    const value = tableMeta.column('_value').get(row);
                    if (every && tableMeta.column('result', false).get(row) === 'battery_counts') {
                        if (!batteryCounts.has(time)) batteryCounts.set(time, {});
                        batteryCounts.get(time)[field] = value;
                        return;
                    }
                    if (field === 'power1' || field === 'power2') {
                        data[field].push({_time: time, _value: value});
                    } else {
                        if (!batteryRows.has(time)) batteryRows.set(time, {_time: time});
                        batteryRows.get(time)[field === 'socPercent' ? '_value' : field] = value;
                    }
                },
                error: reject,
                complete() {
                    if (every) {
                        for (const [time, row] of batteryRows) {
                            const counts = batteryCounts.get(time);
                            for (const field of ['packInputPower', 'outputPackPower']) {
                                if (!counts || !(counts.socPercent > 0) || counts[field] !== counts.socPercent) {
                                    delete row[field];
                                }
                            }
                        }
                    }
                    data.battery = Array.from(batteryRows.values());
                    for (const series of Object.values(data)) {
                        series.sort((a, b) => Date.parse(a._time) - Date.parse(b._time));
                    }
                    resolve(data);
                }
            });
        });
    }

    // Feeds the readings of [start, stop) one by one to sink (an energy
    // accumulator: addNetwork, addSolar, addBattery), keeping no rows in memory.
    // Flux sorts each series, and a series arrives whole before the next one, so
    // the readings of one meter come in time order. The battery fields are
    // pivoted by Influx into one row per timestamp: a row that lacks a power
    // field is passed on as a missing value, never as zero.
    function streamOverRange(start, stop, sink) {
        const source = `from(bucket: ${toFluxValue(config.influx_bucket)})
                |> range(start: ${new Date(start).toISOString()}, stop: ${new Date(stop).toISOString()})
                |> filter(fn: (r) => r["home"] == ${toFluxValue(config.influx_default_tag)})`;
        const query = `${source}
                |> filter(fn: (r) => r["_measurement"] == "power" and (r["_field"] == "power1" or r["_field"] == "power2"))
                |> sort(columns: ["_time"], desc: false)
                |> yield(name: "power")
            ${source}
                |> filter(fn: (r) => r["_measurement"] == "battery" and (r["_field"] == "socPercent" or r["_field"] == "packInputPower" or r["_field"] == "outputPackPower"))
                |> keep(columns: ["_time", "_field", "_value"])
                |> group()
                |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
                |> sort(columns: ["_time"], desc: false)
                |> yield(name: "battery")`;
        return new Promise((resolve, reject) => {
            queryApi.queryRows(query, {
                next(row, tableMeta) {
                    const time = tableMeta.column('_time').get(row);
                    if (tableMeta.column('result', false).get(row) === 'battery') {
                        sink.addBattery(time, tableMeta.column('packInputPower', false).get(row),
                            tableMeta.column('outputPackPower', false).get(row));
                        return;
                    }
                    const value = tableMeta.column('_value').get(row);
                    if (tableMeta.column('_field').get(row) === 'power1') sink.addNetwork(time, value);
                    else sink.addSolar(time, value);
                },
                error: reject,
                complete: resolve
            });
        });
    }

    // Power of each device (the field named after its uri) over [start, stop),
    // preceded by its last value in the week before start.
    function requestDevicePowerOverRange(start, stop, devices) {
        const byDevice = Object.fromEntries(devices.map(device => [device, []]));
        if (!devices.length) return Promise.resolve(byDevice);
        const startISO = new Date(start).toISOString();
        const source = range => `from(bucket: ${toFluxValue(config.influx_bucket)})
                |> range(${range})
                |> filter(fn: (r) => r["home"] == ${toFluxValue(config.influx_default_tag)})
                |> filter(fn: (r) => r["_measurement"] == "power")
                |> filter(fn: (r) => ${devices.map(device => `r["_field"] == ${toFluxValue(device)}`).join(' or ')})`;
        const lookback = new Date(new Date(start).getTime() - DEVICE_LOOKBACK_MS).toISOString();
        const query = `${source(`start: ${lookback}, stop: ${startISO}`)}
                |> last()
                |> yield(name: "before")
            ${source(`start: ${startISO}, stop: ${new Date(stop).toISOString()}`)}
                |> yield(name: "during")`;
        return new Promise((resolve, reject) => {
            queryApi.queryRows(query, {
                next(row, tableMeta) {
                    const field = tableMeta.column('_field').get(row);
                    if (!Object.hasOwn(byDevice, field)) return;
                    byDevice[field].push({_time: tableMeta.column('_time').get(row), _value: tableMeta.column('_value').get(row)});
                },
                error: reject,
                complete() {
                    for (const series of Object.values(byDevice)) {
                        series.sort((a, b) => Date.parse(a._time) - Date.parse(b._time));
                    }
                    resolve(byDevice);
                }
            });
        });
    }

    return {
        requestDevicePowerOverRange,
        requestConsumptionOverPeriod(period, every) {
            return request(`start: -${period}`, every);
        },
        streamConsumptionOverRange: streamOverRange
    };
}

module.exports = {createConsumptionHistory};
