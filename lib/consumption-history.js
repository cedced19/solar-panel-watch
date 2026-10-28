const {metricName, selector, isoTime} = require('./victoria-client');
const {periodToMs} = require('./validate-params');

// Devices write their power only when it changes (advanced mode), so the
// power a device had at the start of a range is its last value before it.
const DEVICE_LOOKBACK_MS = 7 * 24 * 3600 * 1000;
// The day stream asks for one hour of readings at a time.
const STREAM_CHUNK_MS = 3600 * 1000;

const POWER_FIELDS = ['power1', 'power2'];
const BATTERY_FIELDS = ['socPercent', 'packInputPower', 'outputPackPower'];
const NAMES = new Map([
    ...POWER_FIELDS.map(field => [metricName('power', field), field]),
    ...BATTERY_FIELDS.map(field => [metricName('battery', field), field])
]);

// Fetch the meter and pack flows together. SOC rows preserve timestamps where
// the battery reports no power fields, so missing telemetry stays unavailable.
function createConsumptionHistory({client, config}) {
    const labels = () => ({home: config.victoria_default_tag});
    const readings = () => selector([...NAMES.keys()], labels());

    // Adds a series of readings to data: meters as points, battery fields
    // merged into one row per time.
    function collect(data, batteryRows, series) {
        const field = NAMES.get(series.metric.__name__);
        if (!field) return;
        series.timestamps.forEach((ms, i) => {
            const time = isoTime(ms);
            const value = series.values[i];
            if (POWER_FIELDS.includes(field)) {
                data[field].push({_time: time, _value: value});
            } else {
                if (!batteryRows.has(time)) batteryRows.set(time, {_time: time});
                batteryRows.get(time)[field === 'socPercent' ? '_value' : field] = value;
            }
        });
    }

    async function request(period, every) {
        const stop = Date.now();
        const start = stop - periodToMs(period);
        const data = {power1: [], power2: [], battery: []};
        const batteryRows = new Map();
        if (!every) {
            await client.exportSeries(readings(), start, stop, series => collect(data, batteryRows, series));
        } else {
            // Compare each power field's sample count with SOC, which the
            // battery writer always stores. Means must not hide missing fields.
            const step = periodToMs(every);
            const battery = selector(BATTERY_FIELDS.map(field => metricName('battery', field)), labels());
            const [means, counts] = await Promise.all([
                client.queryWindows(`avg_over_time(${readings()}[${step}ms]) keep_metric_names`, start, stop, step),
                client.queryWindows(`count_over_time(${battery}[${step}ms]) keep_metric_names`, start, stop, step)
            ]);
            means.forEach(series => collect(data, batteryRows, series));
            const batteryCounts = new Map();
            counts.forEach((series) => {
                const field = NAMES.get(series.metric.__name__);
                series.timestamps.forEach((ms, i) => {
                    const time = isoTime(ms);
                    if (!batteryCounts.has(time)) batteryCounts.set(time, {});
                    batteryCounts.get(time)[field] = series.values[i];
                });
            });
            for (const [time, row] of batteryRows) {
                const count = batteryCounts.get(time);
                for (const field of ['packInputPower', 'outputPackPower']) {
                    if (!count || !(count.socPercent > 0) || count[field] !== count.socPercent) {
                        delete row[field];
                    }
                }
            }
        }
        data.battery = Array.from(batteryRows.values());
        for (const series of Object.values(data)) {
            series.sort((a, b) => Date.parse(a._time) - Date.parse(b._time));
        }
        return data;
    }

    // Feeds the readings of [start, stop) one by one to sink (an energy
    // accumulator: addNetwork, addSolar, addBattery, with ms timestamps), an hour
    // at a time, so only an hour of readings is held in memory. The samples of a
    // series arrive in time order, so the readings of one meter come in time
    // order. The battery fields are merged into one row per timestamp: a row
    // that lacks a power field is passed on as a missing value, never as zero.
    async function streamOverRange(start, stop, sink) {
        const end = new Date(stop).getTime();
        for (let from = new Date(start).getTime(); from < end; from += STREAM_CHUNK_MS) {
            const battery = new Map();
            await client.exportSeries(readings(), from, Math.min(end, from + STREAM_CHUNK_MS), (series) => {
                const field = NAMES.get(series.metric.__name__);
                series.timestamps.forEach((ms, i) => {
                    const value = series.values[i];
                    if (field === 'power1') sink.addNetwork(ms, value);
                    else if (field === 'power2') sink.addSolar(ms, value);
                    else if (field) {
                        if (!battery.has(ms)) battery.set(ms, {});
                        battery.get(ms)[field] = value;
                    }
                });
            });
            for (const ms of Array.from(battery.keys()).sort((a, b) => a - b)) {
                const row = battery.get(ms);
                sink.addBattery(ms, row.packInputPower, row.outputPackPower, row.socPercent);
            }
        }
    }

    // Power of each device (the field named after its uri) over [start, stop),
    // preceded by its last value in the week before start.
    async function requestDevicePowerOverRange(start, stop, devices) {
        const byDevice = Object.fromEntries(devices.map(device => [device, []]));
        if (!devices.length) return byDevice;
        const startMs = new Date(start).getTime();
        const names = new Map(devices.map(device => [metricName('power', device), device]));
        const before = new Map();
        await client.exportSeries(selector([...names.keys()], labels()), startMs - DEVICE_LOOKBACK_MS,
            new Date(stop).getTime(), (series) => {
                const device = names.get(series.metric.__name__);
                if (!device) return;
                series.timestamps.forEach((ms, i) => {
                    const point = {_time: isoTime(ms), _value: series.values[i]};
                    if (ms >= startMs) byDevice[device].push(point);
                    else before.set(device, point);
                });
            });
        for (const [device, point] of before) byDevice[device].unshift(point);
        return byDevice;
    }

    return {
        requestDevicePowerOverRange,
        requestConsumptionOverPeriod: request,
        streamConsumptionOverRange: streamOverRange
    };
}

module.exports = {createConsumptionHistory};
