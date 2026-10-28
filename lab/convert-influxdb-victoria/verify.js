// Checks a conversion: for every series and every UTC day, compares the number
// of points and their sum in InfluxDB and in VictoriaMetrics. Exits with code 1
// when they differ.
//
//   node lab/convert-influxdb-victoria/verify.js [--start ...] [--stop ...]
//
// Two InfluxDB points of a series less than a millisecond apart are one sample
// in VictoriaMetrics (it keeps the biggest value): a day that differs is counted
// again from InfluxDB's raw points that way, and passes if it then matches.
const {createVictoriaClient, isoTime} = require('../../lib/victoria-client');
const {queryFlux, rowTags, fluxString, readOptions, readSpan} = require('./influx');

const DAY_MS = 24 * 3600 * 1000;
// VictoriaMetrics stores values with about 12 significant digits.
const SUM_TOLERANCE = 1e-6;

function seriesKey(name, labels) {
    const pairs = Object.keys(labels).filter(key => key !== '__name__').sort().map(key => `${key}=${JSON.stringify(labels[key])}`);
    return name + '{' + pairs.join(',') + '}';
}

// {seriesKey: Map(dayEnd ms -> {count, sum})}
function addDay(series, key, time, field, value) {
    if (!series.has(key)) series.set(key, new Map());
    const days = series.get(key);
    if (!days.has(time)) days.set(time, {count: 0, sum: 0});
    days.get(time)[field] = value;
}

// Also fills filters with the Flux filter of each series, by key.
async function readInflux(options, start, stop, filters) {
    const series = new Map();
    for (const fn of ['count', 'sum']) {
        const query = `from(bucket: ${fluxString(options['influx-bucket'])})
            |> range(start: ${isoTime(start)}, stop: ${isoTime(stop)})
            |> aggregateWindow(every: 1d, fn: ${fn}, createEmpty: false)`;
        await queryFlux(options, query, (row) => {
            const tags = rowTags(row);
            const key = seriesKey(row._measurement + '_' + row._field, tags);
            addDay(series, key, Date.parse(row._time), fn, Number(row._value));
            filters.set(key, Object.entries({_measurement: row._measurement, _field: row._field, ...tags})
                .map(([name, value]) => `r[${fluxString(name)}] == ${fluxString(value)}`).join(' and '));
        });
    }
    return series;
}

// Count and sum of a series over [from, to) once the points of the same
// millisecond are merged into the biggest one, as VictoriaMetrics does.
async function readInfluxByMs(options, filter, from, to) {
    const byMs = new Map();
    const query = `from(bucket: ${fluxString(options['influx-bucket'])})
        |> range(start: ${isoTime(from)}, stop: ${isoTime(to)})
        |> filter(fn: (r) => ${filter})`;
    await queryFlux(options, query, (row) => {
        const ms = Date.parse(row._time);
        const value = Number(row._value);
        if (!byMs.has(ms) || value > byMs.get(ms)) byMs.set(ms, value);
    });
    return {count: byMs.size, sum: [...byMs.values()].reduce((sum, value) => sum + value, 0)};
}

async function readVictoria(options, start, stop) {
    const victoria = createVictoriaClient({url: options['victoria-url']});
    const series = new Map();
    for (const fn of ['count', 'sum']) {
        const result = await victoria.queryWindows(`${fn}_over_time({__name__=~".+"}[${DAY_MS}ms]) keep_metric_names`,
            start, stop, DAY_MS);
        for (const {metric, timestamps, values} of result) {
            const key = seriesKey(metric.__name__, metric);
            timestamps.forEach((time, i) => addDay(series, key, time, fn, values[i]));
        }
    }
    return series;
}

function differs(a, b) {
    return Math.abs(a - b) > SUM_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
}

async function verify(options) {
    const span = await readSpan(options);
    if (!span) {
        console.log('The bucket holds no data.');
        return true;
    }
    // Whole UTC days, as both databases cut them.
    const start = Math.floor(span.start / DAY_MS) * DAY_MS;
    const filters = new Map();
    const [influx, victoria] = await Promise.all([readInflux(options, start, span.stop, filters),
        readVictoria(options, start, span.stop)]);
    console.log(`Points per series, ${isoTime(start)} to ${isoTime(span.stop)}:`);
    let ok = true;
    for (const key of [...new Set([...influx.keys(), ...victoria.keys()])].sort()) {
        const before = influx.get(key) || new Map();
        const after = victoria.get(key) || new Map();
        const total = days => [...days.values()].reduce((sum, day) => sum + day.count, 0);
        const same = (a = {count: 0, sum: 0}, b = {count: 0, sum: 0}) => a.count === b.count && !differs(a.sum, b.sum);
        const wrong = [];
        let merged = 0;
        for (const time of [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b)) {
            if (same(before.get(time), after.get(time))) continue;
            const byMs = filters.has(key) && await readInfluxByMs(options, filters.get(key),
                Math.max(start, Math.ceil(time / DAY_MS) * DAY_MS - DAY_MS), time);
            if (byMs && same(byMs, after.get(time))) merged += before.get(time).count - byMs.count;
            else wrong.push(time);
        }
        console.log(`  ${wrong.length ? 'DIFF' : 'ok  '} ${key}: InfluxDB ${total(before)}, VictoriaMetrics ${total(after)}` +
            (merged ? ` (${merged} points less than 1 ms after another merged)` : '') +
            (wrong.length ? `, ${wrong.length} of ${before.size} days differ` : ''));
        for (const time of wrong.slice(0, 5)) {
            const a = before.get(time) || {count: 0, sum: 0};
            const b = after.get(time) || {count: 0, sum: 0};
            console.log(`         day ending ${isoTime(time)}: count ${a.count} / ${b.count}, sum ${a.sum} / ${b.sum}`);
        }
        if (wrong.length) ok = false;
    }
    console.log(ok ? '\nBoth databases hold the same points.' : '\nThe databases differ.');
    return ok;
}

if (require.main === module) {
    const options = readOptions({});
    if (options.help) {
        console.log('Compares InfluxDB and VictoriaMetrics per series and UTC day; same options as convert.js.');
    } else {
        verify(options).then((ok) => {
            if (!ok) process.exitCode = 1;
        }, (error) => {
            console.error(error);
            process.exitCode = 1;
        });
    }
}

module.exports = {verify};
