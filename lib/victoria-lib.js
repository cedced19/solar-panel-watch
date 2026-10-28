const config = require('../config.json');
const {createVictoriaClient, metricName, selector, formatLine, isoTime} = require('./victoria-client');
const {periodToMs} = require('./validate-params');

const client = createVictoriaClient({url: config.victoria_url});
const {createConsumptionHistory} = require('./consumption-history');
const {requestConsumptionOverPeriod, streamConsumptionOverRange, requestDevicePowerOverRange} =
    createConsumptionHistory({client, config});

function logWithDate(message) {
  var currentDate = new Date();
  console.log(currentDate.toLocaleString() + ": ", message);
}

// Points are buffered in one writer and sent to VictoriaMetrics every
// WRITE_FLUSH_MS, so a reading per second costs one request per few seconds.
// A batch that cannot be sent stays in the buffer and goes with the next one
// (beyond MAX_BUFFERED_LINES, the oldest readings are dropped); a batch that
// VictoriaMetrics rejects as invalid is dropped. Points that wait in the buffer
// are lost if the process dies, hence flush() before exiting.
const WRITE_FLUSH_MS = 5000;
const MAX_BUFFERED_LINES = 100000;

function createSharedWriteApi({client: writeClient, log = logWithDate, logError = console.error,
    flushInterval = WRITE_FLUSH_MS, maxBufferedLines = MAX_BUFFERED_LINES}) {
    let lines = [];
    let timer = null;
    let sending = Promise.resolve();

    function schedule() {
        if (timer) return;
        timer = setTimeout(send, flushInterval);
        // The HTTP server keeps the process running, a pending batch must not.
        if (typeof timer.unref === 'function') timer.unref();
    }

    function send() {
        clearTimeout(timer);
        timer = null;
        sending = sending.then(async () => {
            if (!lines.length) return;
            const batch = lines;
            lines = [];
            try {
                await writeClient.write(batch);
            } catch (error) {
                const rejected = error.status >= 400 && error.status < 500;
                log(rejected ? 'VictoriaMetrics rejected a batch of readings, which is dropped.' :
                    'Failed at updating VictoriaMetrics: cannot connect to db.');
                logError(error);
                if (rejected) return;
                lines = batch.concat(lines).slice(-maxBufferedLines);
                schedule();
            }
        });
        return sending;
    }

    return {
        write(line) {
            lines.push(line);
            if (lines.length > maxBufferedLines) lines.shift();
            schedule();
        },
        // Sends what is buffered, including batches waiting for a retry.
        flush: send
    };
}

function createPowerWriter(dependencies = {}) {
    const powerConfig = dependencies.config || config;
    const now = dependencies.now || Date.now;
    const log = dependencies.log || logWithDate;
    const writes = dependencies.writes || createSharedWriteApi({client: dependencies.client || client, log,
        logError: dependencies.logError});

    function write(debug, data, networkData) {
        const meters = data && Array.isArray(data.emeters) ? data.emeters : [];
        const fields = {};
        meters.slice(0, 2).forEach((meter, index) => {
            if (!meter) return;
            const names = networkData && !(index === 0 && data.housePowerSource === 'zendure') ?
                ['power', 'reactive', 'pf', 'voltage'] : ['power'];
            names.forEach((name) => {
                if (Number.isFinite(meter[name])) fields[name + (index + 1)] = meter[name];
            });
        });
        // The reading is stamped now, when it is polled: the batch is sent later.
        // An unavailable solar channel must remain a gap in history, rather
        // than an artificial zero, so a reading without any field is not written.
        const line = formatLine('power', {home: powerConfig.victoria_default_tag}, fields, now());
        if (line) {
            writes.write(line);
            if (debug) log('Data queued for VictoriaMetrics.');
        }
        return Promise.resolve();
    }

    function writePowerRaw(debug, data) {
        return write(debug, data, false);
    }

    function writeNetworkData(debug, data) {
        return write(debug, data, true);
    }

    return {writePowerRaw, writeNetworkData};
}

const writes = createSharedWriteApi({client});
const {writePowerRaw, writeNetworkData} = createPowerWriter({writes});

// Raw points of the fields of a measurement over [start, stop) (ms), as
// {field: [{_time, _value}]} with each array in time order.
function requestFieldsOverRange(measurement, fields, start, stop) {
    const byField = Object.fromEntries(fields.map((field) => [field, []]));
    const names = new Map(fields.map((field) => [metricName(measurement, field), field]));
    return client.exportSeries(selector([...names.keys()], {home: config.victoria_default_tag}), start, stop, (series) => {
        const points = byField[names.get(series.metric.__name__)];
        if (!points) return;
        series.timestamps.forEach((time, i) => {
            points.push({_time: isoTime(time), _value: series.values[i]});
        });
    }).then(() => byField);
}

// [start, stop) of the period (e.g. "24h") that ends now.
function lastPeriod(period) {
    const stop = Date.now();
    return {start: stop - periodToMs(period), stop};
}

function createBatteryHistory(dependencies = {}) {
    const batteryClient = dependencies.client || client;
    const batteryConfig = dependencies.config || config;
    const now = dependencies.now || Date.now;
    const log = dependencies.log || logWithDate;
    const writes = dependencies.writes ||
        createSharedWriteApi({client: batteryClient, log, logError: dependencies.logError});
    const powerFields = [
        ['outputHomePower', 'outputHomePowerW'],
        ['gridInputPower', 'gridInputPowerW'],
        ['outputPackPower', 'chargingPowerW'],
        ['packInputPower', 'dischargingPowerW']
    ];

    async function writeBatteryLevel(debug, battery) {
        if (!battery || !Number.isFinite(battery.socPercent) || battery.socPercent < 0 || battery.socPercent > 100) return;
        const receivedTime = battery.time;
        // Preserve cached readings' timestamps so repeated polls cannot create artificial history.
        if (receivedTime != null && !Number.isFinite(receivedTime)) return;
        const timestamp = receivedTime == null ? now() : receivedTime * 1000;
        if (!Number.isFinite(new Date(timestamp).getTime())) return;

        const fields = {socPercent: battery.socPercent};
        powerFields.forEach(([field, property]) => {
            const value = battery[property];
            if (Number.isFinite(value) && value >= 0) fields[field] = value;
        });
        writes.write(formatLine('battery', {home: batteryConfig.victoria_default_tag}, fields, timestamp));
        if (debug) log('Battery level queued for VictoriaMetrics.');
    }

    // One row per reading time, in time order: {_time, _value: socPercent or
    // null, <power field>: W}. Rows are merged on the ms timestamp.
    function requestBatteryLevelOverPeriod(period) {
        const {start, stop} = lastPeriod(period);
        const fields = new Map(['socPercent', ...powerFields.map(([field]) => field)]
            .map((field) => [metricName('battery', field), field]));
        const rows = new Map();
        const labels = {home: batteryConfig.victoria_default_tag};
        return batteryClient.exportSeries(selector([...fields.keys()], labels), start, stop, (series) => {
            const field = fields.get(series.metric.__name__);
            if (!field) return;
            series.timestamps.forEach((time, i) => {
                if (!rows.has(time)) rows.set(time, {_time: time, _value: null});
                rows.get(time)[field === 'socPercent' ? '_value' : field] = series.values[i];
            });
        }).then(() => Array.from(rows.values())
            .sort((a, b) => a._time - b._time)
            .map((row) => Object.assign(row, {_time: isoTime(row._time)})));
    }

    return {writeBatteryLevel, requestBatteryLevelOverPeriod};
}

const {writeBatteryLevel, requestBatteryLevelOverPeriod} = createBatteryHistory({writes});

function writeOne(debug, measurement, name, value, message) {
    const line = formatLine(measurement, {home: config.victoria_default_tag}, {[name]: value}, Date.now());
    if (!line) return;
    writes.write(line);
    if (debug) logWithDate(message);
}

function writePower(debug, name, value) {
    writeOne(debug, 'power', name, value, 'Power queued for VictoriaMetrics.');
}

function writeVar(debug, name, value) {
    writeOne(debug, 'var', name, value, 'Variable queued for VictoriaMetrics.');
}

function requestOverPeriod(measurement, period, tag) {
    const {start, stop} = lastPeriod(period);
    return requestFieldsOverRange(measurement, [tag], start, stop).then(byField => byField[tag]);
}

function requestPowerOverPeriod(period, tag) {
    return requestOverPeriod('power', period, tag);
}

// Stream power points over a period without buffering them: onValue(tsMs, value)
// is called as samples arrive, onDone(err) once finished. Memory stays bounded
// by one exported line, however many points the period spans.
function streamPowerOverPeriod(period, tag, onValue, onDone) {
    const {start, stop} = lastPeriod(period);
    client.exportSeries(selector(metricName('power', tag), {home: config.victoria_default_tag}), start, stop, (series) => {
        series.timestamps.forEach((time, i) => onValue(time, series.values[i]));
    }).then(() => onDone(null), onDone);
}

// Trapezoidal integral of a power series over the period, like Influx's
// integral(unit: 1h): resolves with the Wh value, or null when no data falls
// in the period. The points are streamed, so memory stays bounded.
function requestPowerIntegralOverPeriod(period, tag) {
    return new Promise(function(resolve, reject) {
        let value = null;
        let prevT = null;
        let prevV = null;
        streamPowerOverPeriod(period, tag, function (t, v) {
            value = prevT === null ? 0 : value + (prevV + v) / 2 * (t - prevT) / 3600000;
            prevT = t;
            prevV = v;
        }, function (err) {
            if (err) return reject(err);
            resolve(value);
        });
    });
}

// Fetch several power fields in a single query and resolve with an object
// mapping each tag to its (compact) point array.
function requestPowerOverPeriodMulti(period, tags) {
    const {start, stop} = lastPeriod(period);
    return requestFieldsOverRange('power', tags, start, stop);
}

// Fetch several power fields over an absolute time range [start, stop) (Date
// objects or ISO strings) and resolve with an object mapping each tag to its
// point array.
function requestPowerOverRange(start, stop, tags) {
    return requestFieldsOverRange('power', tags, new Date(start).getTime(), new Date(stop).getTime());
}

// Pick an aggregation window that keeps the number of graphed points bounded.
// Returns null (no aggregation) for short periods or when every is provided.
function getAggregateWindow(period) {
    const units = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
    const m = /^(\d+)([smhdwy])$/.exec(period);
    if (!m) return null;
    const seconds = parseInt(m[1], 10) * units[m[2]];
    if (seconds < 3600) return null;       // < 1h: raw is already small
    if (seconds < 86400) return '1m';      // 1h - 1d
    if (seconds < 604800) return '30m';    // 1d - 7d
    return '1h';                           // >= 7d
}

// Mean of a power field per window of `every` (e.g. "5m") over the period,
// stamped with the end of each window; windows without data are left out.
function requestPowerMeansOverPeriod(period, tag, every) {
    const {start, stop} = lastPeriod(period);
    const step = periodToMs(every);
    const query = `avg_over_time(${selector(metricName('power', tag), {home: config.victoria_default_tag})}[${step}ms])`;
    return client.queryWindows(query, start, stop, step).then(function (result) {
        if (!result.length) return [];
        return result[0].timestamps.map((time, i) => ({_time: isoTime(time), _value: result[0].values[i]}));
    });
}

// Graph-friendly power series, downsampled to a moving average. The window `every`
// can be passed explicitly (e.g. "5m") or, when omitted, chosen automatically from
// the period. Returns raw points when no window applies (short period / explicit
// "raw"). Use requestPowerOverPeriod for raw points (energy).
function requestPowerOverPeriodGraph(period, tag, every) {
    const window = every || getAggregateWindow(period);
    if (!window) return requestPowerOverPeriod(period, tag);
    return requestPowerMeansOverPeriod(period, tag, window);
}

// Serialize the selected columns of a points array to CSV. Much lighter to transfer
// and parse than the equivalent JSON when graphing large series.
function pointsToCSV(points, columns = ['_time', '_value']) {
    let out = columns.join(',');
    for (let i = 0; i < points.length; i++) {
        out += '\n' + columns.map((column) => points[i][column] ?? '').join(',');
    }
    return out;
}

function requestVarOverPeriod(period, tag) {
    return requestOverPeriod('var', period, tag);
}

// Last point of the day before now, as an array of zero or one point.
function requestLast(measurement, tag) {
    return requestOverPeriod(measurement, '1d', tag).then(points => points.slice(-1));
}

function requestLastVar(tag) {
    return requestLast('var', tag);
}

function requestLastPower(tag) {
    return requestLast('power', tag);
}

function requestPowerOverPeriodGroupBy(period, tag, group) {
    return requestPowerMeansOverPeriod(period, tag, group);
}

function getMaxValueOverData(array) {
    let maxValue = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < array.length; i++) {
      if (array[i]['_value'] > maxValue) {
        maxValue = array[i]['_value'];
      }
    }
    return maxValue;
}

module.exports = {
    requestConsumptionOverPeriod,
    streamConsumptionOverRange,
    requestDevicePowerOverRange,
    flushWrites: () => writes.flush(),
    createSharedWriteApi,
    createPowerWriter: createPowerWriter,
    createBatteryHistory: createBatteryHistory,
    writeBatteryLevel: writeBatteryLevel,
    requestBatteryLevelOverPeriod: requestBatteryLevelOverPeriod,
    writePower : writePower,
    writeVar: writeVar,
    writeNetworkData: writeNetworkData,
    requestLastVar: requestLastVar,
    requestLastPower: requestLastPower,
    requestPowerOverPeriod: requestPowerOverPeriod,
    streamPowerOverPeriod: streamPowerOverPeriod,
    requestPowerIntegralOverPeriod: requestPowerIntegralOverPeriod,
    requestPowerOverPeriodMulti: requestPowerOverPeriodMulti,
    requestPowerOverRange: requestPowerOverRange,
    requestPowerOverPeriodGraph: requestPowerOverPeriodGraph,
    getAggregateWindow: getAggregateWindow,
    pointsToCSV: pointsToCSV,
    requestVarOverPeriod: requestVarOverPeriod,
    requestPowerOverPeriodGroupBy: requestPowerOverPeriodGroupBy,
    writePowerRaw: writePowerRaw,
    getMaxValueOverData: getMaxValueOverData
};
