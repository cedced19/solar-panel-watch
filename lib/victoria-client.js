// Minimal client for the HTTP API of a single-node VictoriaMetrics, without
// dependencies. Readings are written as Influx line protocol: the field
// <field> of the measurement <measurement> becomes the metric
// <measurement>_<field>, its tags become labels. They are read back as raw
// samples (/api/v1/export) or computed per window (/api/v1/query_range).
//
// Times are milliseconds since the epoch, sent as ISO strings so that no
// millisecond is lost in a conversion to float seconds.

// A series is exported in time-ordered lines of at most this many samples, so
// a long range is parsed piece by piece.
const EXPORT_ROWS_PER_LINE = 10000;
// Data range of one window query (see queryWindows).
const QUERY_CHUNK_MS = 24 * 3600 * 1000;
const WRITE_TIMEOUT_MS = 10000;
const QUERY_TIMEOUT_MS = 60000;

function metricName(measurement, field) {
    return measurement + '_' + field;
}

// Series selector matching the metrics of names (one or several) with the
// given labels. Values are quoted as JSON strings, which MetricsQL reads back
// as they are, so a name cannot change the query.
function selector(names, labels = {}) {
    const filters = Object.entries(labels).map(([key, value]) => key + '=' + JSON.stringify(String(value))).join(',');
    return '{' + [].concat(names).map(name => '__name__=' + JSON.stringify(name) + (filters ? ',' + filters : ''))
        .join(' or ') + '}';
}

const escapeMeasurement = value => String(value).replace(/[, ]/g, '\\$&');
const escapeKey = value => String(value).replace(/[,= ]/g, '\\$&');

// One line of Influx line protocol (millisecond timestamp), or null when no
// field is a finite number: VictoriaMetrics would reject the whole batch.
function formatLine(measurement, tags, fields, timestamp) {
    const values = Object.entries(fields)
        .filter(([, value]) => Number.isFinite(value))
        .map(([key, value]) => escapeKey(key) + '=' + value);
    if (!values.length) return null;
    const labels = Object.entries(tags).map(([key, value]) => ',' + escapeKey(key) + '=' + escapeKey(value)).join('');
    return escapeMeasurement(measurement) + labels + ' ' + values.join(',') + ' ' + Math.round(timestamp);
}

const isoTime = ms => new Date(ms).toISOString();

function createVictoriaClient({url, fetch = globalThis.fetch}) {
    const base = String(url).replace(/\/+$/, '');

    async function post(path, body, timeout) {
        const response = await fetch(base + path, {method: 'POST', body, signal: AbortSignal.timeout(timeout)});
        if (!response.ok) {
            const error = new Error('VictoriaMetrics ' + path + ' answered ' + response.status + ': ' +
                (await response.text()).trim());
            error.status = response.status;
            throw error;
        }
        return response;
    }

    // Sends lines of Influx line protocol (millisecond timestamps).
    async function write(lines) {
        await post('/write?precision=ms', lines.join('\n'), WRITE_TIMEOUT_MS);
    }

    // Raw samples of the series matching the selectors over [start, stop), in
    // time order for each series. onSeries({metric, timestamps, values}) is
    // called as each line arrives; a series can come in several lines.
    async function exportSeries(selectors, start, stop, onSeries) {
        const params = new URLSearchParams({start: isoTime(start), end: isoTime(stop - 1),
            max_rows_per_line: String(EXPORT_ROWS_PER_LINE)});
        [].concat(selectors).forEach(match => params.append('match[]', match));
        const response = await post('/api/v1/export', params, QUERY_TIMEOUT_MS);
        const decoder = new TextDecoder();
        let rest = '';
        for await (const chunk of response.body) {
            const lines = (rest + decoder.decode(chunk, {stream: true})).split('\n');
            rest = lines.pop();
            for (const line of lines) {
                if (line) onSeries(JSON.parse(line));
            }
        }
        rest += decoder.decode();
        if (rest.trim()) onSeries(JSON.parse(rest));
    }

    // Evaluates a rollup query whose lookbehind window is `[<step>ms]` once per
    // window [t - step, t), with t on the multiples of step, over [start, stop),
    // like Influx's aggregateWindow(createEmpty: false): each point is stamped
    // with the end of its window, the last one with stop. Windows without
    // samples are left out. Resolves with [{metric, timestamps, values}].
    //
    // VictoriaMetrics unpacks every raw sample a request covers: a year of 1 s
    // readings at once gets it killed in a 250m container. So the windows are
    // asked for QUERY_CHUNK_MS of data at a time (at least one window).
    async function queryWindows(query, start, stop, step) {
        const first = Math.floor(start / step) * step + step;
        const last = Math.floor((stop - 1) / step) * step + step;
        const perRequest = Math.max(1, Math.floor(QUERY_CHUNK_MS / step)) * step;
        const bySeries = new Map();
        for (let from = first; from <= last; from += perRequest) {
            // A window evaluated 1 ms before its end covers (t - step - 1 ms, t - 1 ms],
            // that is [t - step, t) for millisecond timestamps. nocache: otherwise
            // VictoriaMetrics rounds start and end to multiples of step (and leaves
            // out the last 30 seconds) to cache the result.
            const params = new URLSearchParams({query, start: isoTime(from - 1),
                end: isoTime(Math.min(last, from + perRequest - step) - 1), step: step + 'ms', nocache: '1'});
            const response = await post('/api/v1/query_range', params, QUERY_TIMEOUT_MS);
            for (const {metric, values} of (await response.json()).data.result) {
                const key = JSON.stringify(metric);
                if (!bySeries.has(key)) bySeries.set(key, {metric, timestamps: [], values: []});
                const series = bySeries.get(key);
                for (const [time, value] of values) {
                    series.timestamps.push(Math.min(Math.round(time * 1000) + 1, stop));
                    series.values.push(Number(value));
                }
            }
        }
        return Array.from(bySeries.values());
    }

    return {write, exportSeries, queryWindows};
}

module.exports = {createVictoriaClient, metricName, selector, formatLine, isoTime, EXPORT_ROWS_PER_LINE};
