const {toFluxValue} = require('@influxdata/influxdb-client');

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

    return {
        requestConsumptionOverPeriod(period, every) {
            return request(`start: -${period}`, every);
        },
        requestConsumptionOverRange(start, stop) {
            return request(`start: ${new Date(start).toISOString()}, stop: ${new Date(stop).toISOString()}`);
        }
    };
}

module.exports = {createConsumptionHistory};
