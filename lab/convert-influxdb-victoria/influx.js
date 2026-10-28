// Reads an InfluxDB 2.x bucket through its HTTP API (Flux, answered as CSV),
// streaming the rows. Defaults are the settings of the former docker-compose.yml.
const {parseArgs} = require('node:util');

const INFLUX_DEFAULTS = {
    'influx-url': 'http://127.0.0.1:8086',
    'influx-token': 'joWbkcAOqD8hPtRRyEz7U64PLqOrPO',
    'influx-org': 'solar_panel_org',
    'influx-bucket': 'solar_panel'
};

// Columns of a Flux row that are not tags.
const NOT_TAGS = new Set(['', 'result', 'table', '_start', '_stop', '_time', '_value', '_field', '_measurement']);

// Splits one CSV line, with RFC 4180 quoting.
function splitCSV(line) {
    const cells = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
            if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; }
            else if (c === '"') quoted = false;
            else cell += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { cells.push(cell); cell = ''; }
        else cell += c;
    }
    cells.push(cell);
    return cells;
}

// Runs a Flux query and calls onRow(row) for each row, an object of strings
// keyed by column. Tables are separated by an empty line and their own header.
// When onRow returns a promise, reading waits for it.
async function queryFlux(options, query, onRow) {
    const url = options['influx-url'].replace(/\/+$/, '') + '/api/v2/query?org=' + encodeURIComponent(options['influx-org']);
    const response = await fetch(url, {
        method: 'POST',
        headers: {Authorization: 'Token ' + options['influx-token'], 'Content-Type': 'application/json', Accept: 'application/csv'},
        body: JSON.stringify({query, dialect: {header: true, annotations: [], delimiter: ','}})
    });
    if (!response.ok) throw new Error('InfluxDB answered ' + response.status + ': ' + (await response.text()).trim());
    const decoder = new TextDecoder();
    let header = null;
    let rest = '';
    const handle = (line) => {
        line = line.replace(/\r$/, '');
        if (!line) { header = null; return; }
        const cells = splitCSV(line);
        if (!header) { header = cells; return; }
        const row = {};
        header.forEach((name, i) => { row[name] = cells[i]; });
        return onRow(row);
    };
    for await (const chunk of response.body) {
        const lines = (rest + decoder.decode(chunk, {stream: true})).split('\n');
        rest = lines.pop();
        for (const line of lines) {
            const pending = handle(line);
            if (pending) await pending;
        }
    }
    rest += decoder.decode();
    if (rest) await handle(rest);
}

// Tags of a Flux row: every column that is not a Flux or time/value column.
function rowTags(row) {
    const tags = {};
    for (const [name, value] of Object.entries(row)) {
        if (!NOT_TAGS.has(name) && value !== '' && value !== undefined) tags[name] = value;
    }
    return tags;
}

const fluxString = value => JSON.stringify(String(value));

// Parses the shared command line options; extra describes the script's own.
function readOptions(extra) {
    const options = {
        help: {type: 'boolean', short: 'h'},
        'victoria-url': {type: 'string', default: 'http://127.0.0.1:8428'},
        start: {type: 'string'},
        stop: {type: 'string'},
        ...Object.fromEntries(Object.entries(INFLUX_DEFAULTS).map(([name, value]) => [name, {type: 'string', default: value}])),
        ...extra
    };
    return parseArgs({options}).values;
}

// First and last time of the bucket's data, as ms, or null when it is empty.
async function bucketSpan(options) {
    const times = [];
    const query = `from(bucket: ${fluxString(options['influx-bucket'])})
        |> range(start: 0)
        |> {fn}()
        |> group()
        |> {agg}(column: "_time")
        |> keep(columns: ["_time"])`;
    for (const [fn, agg] of [['first', 'min'], ['last', 'max']]) {
        await queryFlux(options, query.replace('{fn}', fn).replace('{agg}', agg), row => times.push(Date.parse(row._time)));
    }
    return times.length === 2 ? {start: times[0], stop: times[1] + 1} : null;
}

// [start, stop) to work on, in ms: --start/--stop (dates) or the bucket's data.
async function readSpan(options) {
    const span = (options.start && options.stop) ? null : await bucketSpan(options);
    const start = options.start ? Date.parse(options.start) : span && span.start;
    const stop = options.stop ? Date.parse(options.stop) : span && span.stop;
    if (start == null || stop == null) return null;
    if (!Number.isFinite(start) || !Number.isFinite(stop)) throw new Error('--start and --stop take dates like 2026-01-31T00:00:00Z.');
    return {start, stop};
}

module.exports = {INFLUX_DEFAULTS, queryFlux, rowTags, fluxString, readOptions, readSpan};
