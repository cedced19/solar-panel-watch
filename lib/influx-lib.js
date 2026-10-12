const {InfluxDB, Point, toFluxValue} = require('@influxdata/influxdb-client');
const getPowerData = require('./get-power-data.js');
const config = require('../config.json');

const token = config.influx_tocken;
const org = config.influx_org;
const bucket = config.influx_bucket;
const defaultTag = config.influx_default_tag;
const url = config.influx_url;

const client = new InfluxDB({url: url, token: token});
const queryApi = client.getQueryApi(org);

function logWithDate(message) {
  var currentDate = new Date();
  console.log(currentDate.toLocaleString() + ": ", message);
}

function createPowerWriter(dependencies = {}) {
    const powerClient = dependencies.client || client;
    const PointClass = dependencies.Point || Point;
    const powerData = dependencies.powerData || getPowerData;
    const powerConfig = dependencies.config || config;
    const log = dependencies.log || logWithDate;
    const logError = dependencies.logError || console.error;

    function write(debug, data, networkData) {
        const meters = data && Array.isArray(data.emeters) ? data.emeters : [];
        const point = new PointClass('power');
        let fieldCount = 0;
        meters.slice(0, 2).forEach((meter, index) => {
            if (!meter) return;
            const fields = networkData && !(index === 0 && data.housePowerSource === 'zendure') ?
                ['power', 'reactive', 'pf', 'voltage'] : ['power'];
            fields.forEach((field) => {
                if (Number.isFinite(meter[field])) {
                    point.floatField(field + (index + 1), meter[field]);
                    fieldCount++;
                }
            });
        });
        // An unavailable solar channel must remain a gap in history, rather
        // than an artificial zero created by Influx's numeric conversion.
        if (fieldCount === 0) return Promise.resolve();

        const writeApi = powerClient.getWriteApi(powerConfig.influx_org, powerConfig.influx_bucket);
        writeApi.useDefaultTags({home: powerConfig.influx_default_tag});
        writeApi.writePoint(point);
        return writeApi.close().then(() => {
            if (debug) log('Data updated in InfluxDB.');
        }).catch((error) => {
            log('Failed at updating InfluxDB: cannot connect to db.');
            logError(error);
        });
    }

    function writePowerRaw(debug, data) {
        return write(debug, data, false);
    }

    function writeNetworkData(debug, data) {
        return write(debug, data, true);
    }

    function daemon(debug, logEnabled) {
        powerData.req((error, data) => {
            if (error) {
                log('Failed at updating InfluxDB: house power data is unavailable.');
                logError(error);
                return;
            }
            if (logEnabled) writeNetworkData(debug, data);
            else writePowerRaw(debug, data);
        });
    }

    return {writePowerRaw, writeNetworkData, daemon};
}

const {writePowerRaw, writeNetworkData, daemon} = createPowerWriter();

function createBatteryHistory(dependencies = {}) {
    const batteryClient = dependencies.client || client;
    const PointClass = dependencies.Point || Point;
    const batteryConfig = dependencies.config || config;
    const now = dependencies.now || Date.now;
    const log = dependencies.log || logWithDate;
    const logError = dependencies.logError || console.error;

    async function writeBatteryLevel(debug, battery) {
        if (!battery || !Number.isFinite(battery.socPercent) || battery.socPercent < 0 || battery.socPercent > 100) return;
        const receivedTime = battery.time;
        // Preserve cached readings' timestamps so repeated polls cannot create artificial history.
        if (receivedTime != null && !Number.isFinite(receivedTime)) return;
        const timestamp = new Date(receivedTime == null ? now() : receivedTime * 1000);
        if (!Number.isFinite(timestamp.getTime())) return;

        try {
            const point = new PointClass('battery')
                .floatField('socPercent', battery.socPercent)
                .timestamp(timestamp);
            const writeApi = batteryClient.getWriteApi(batteryConfig.influx_org, batteryConfig.influx_bucket);
            writeApi.useDefaultTags({home: batteryConfig.influx_default_tag});
            writeApi.writePoint(point);
            await writeApi.close();
            if (debug) log('Battery level updated in InfluxDB.');
        } catch (error) {
            log('Failed at updating battery level in InfluxDB.');
            logError(error);
        }
    }

    function requestBatteryLevelOverPeriod(period) {
        return new Promise((resolve, reject) => {
            const points = [];
            const query =
                `from(bucket: ${toFluxValue(batteryConfig.influx_bucket)})
                |> range(start: -${period})
                |> filter(fn: (r) => r["_measurement"] == "battery")
                |> filter(fn: (r) => r["_field"] == "socPercent")
                |> filter(fn: (r) => r["home"] == ${toFluxValue(batteryConfig.influx_default_tag)})
                |> keep(columns: ["_time", "_value"])
                |> group()
                |> sort(columns: ["_time"], desc: false)`;
            const batteryQueryApi = dependencies.queryApi || batteryClient.getQueryApi(batteryConfig.influx_org);
            batteryQueryApi.queryRows(query, {
                next(row, tableMeta) {
                    points.push({
                        _time: tableMeta.column('_time').get(row),
                        _value: tableMeta.column('_value').get(row)
                    });
                },
                error: reject,
                complete() {
                    resolve(points);
                }
            });
        });
    }

    return {writeBatteryLevel, requestBatteryLevelOverPeriod};
}

const {writeBatteryLevel, requestBatteryLevelOverPeriod} = createBatteryHistory();

function writePower(debug, name, value) {
    const writeApi = client.getWriteApi(org, bucket);
    writeApi.useDefaultTags({home: defaultTag});
    const point = new Point('power')
    .floatField(name, value)
    writeApi.writePoint(point)
    writeApi
        .close()
        .then(() => {
            if (debug) {
                logWithDate('Power updated in InfluxDB.');
            }
        })
        .catch(e => {
            console.error(e);
            logWithDate('Failed at updating InfluxDB.');
        });
}

function writeVar(debug, name, value) {
    const writeApi = client.getWriteApi(org, bucket);
    writeApi.useDefaultTags({home: defaultTag});
    const point = new Point('var')
    .floatField(name, value)
    writeApi.writePoint(point)
    writeApi
        .close()
        .then(() => {
            if (debug) {
                logWithDate('Variable updated in InfluxDB.');
            }
        })
        .catch(e => { 
            console.error(e);
            logWithDate('Failed at updating InfluxDB.');
        });
}

function requestPowerOverPeriod(period, tag) {
    return new Promise(function(resolve, reject) {
        let csv = []
            const query = 
            `from(bucket: "${bucket}")
            |> range(start: -${period})
            |> filter(fn: (r) => r["_measurement"] == "power")
            |> filter(fn: (r) => r["_field"] == "${tag}")
            |> yield(name: "mean")`

            queryApi.queryRows(query, {
                next(row, tableMeta) {
                    // keep only the fields the consumers actually use to cut memory
                    csv.push({ _time: tableMeta.column('_time').get(row), _value: tableMeta.column('_value').get(row) });
                },
                reject,
                complete() {
                    resolve(csv);
                }
            });
    });
}

// Stream power points over a period without buffering them: onValue(tsMs, value)
// is called as rows arrive, onDone(err) once finished. O(1) memory regardless
// of how many points the period spans.
function streamPowerOverPeriod(period, tag, onValue, onDone) {
    const query =
        `from(bucket: "${bucket}")
        |> range(start: -${period})
        |> filter(fn: (r) => r["_measurement"] == "power")
        |> filter(fn: (r) => r["_field"] == "${tag}")`

    queryApi.queryRows(query, {
        next(row, tableMeta) {
            // read only the two columns we need, avoiding a per-row object
            onValue(Date.parse(tableMeta.column('_time').get(row)), tableMeta.column('_value').get(row));
        },
        reject(err) { onDone(err); },
        complete() { onDone(null); }
    });
}

// Compute the integral of a power series directly in InfluxDB and resolve with
// the resulting Wh value (or null when no data falls in the period). O(1) data
// transfer regardless of how many points the period spans.
function requestPowerIntegralOverPeriod(period, tag) {
    return new Promise(function(resolve, reject) {
        const query =
            `from(bucket: "${bucket}")
            |> range(start: -${period})
            |> filter(fn: (r) => r["_measurement"] == "power")
            |> filter(fn: (r) => r["_field"] == "${tag}")
            |> integral(unit: 1h)`

        let value = null;
        queryApi.queryRows(query, {
            next(row, tableMeta) {
                value = tableMeta.column('_value').get(row);
            },
            reject,
            complete() {
                resolve(value);
            }
        });
    });
}

// Fetch several power fields in a single InfluxDB query and resolve with an
// object mapping each tag to its (compact) point array. Halves the number of
// round-trips versus querying each field separately.
function requestPowerOverPeriodMulti(period, tags) {
    return new Promise(function(resolve, reject) {
        const byField = {};
        tags.forEach(function (tag) {
            byField[tag] = [];
        });
        const fieldFilter = tags.map(function (tag) {
            return `r["_field"] == "${tag}"`;
        }).join(' or ');

        const query =
            `from(bucket: "${bucket}")
            |> range(start: -${period})
            |> filter(fn: (r) => r["_measurement"] == "power")
            |> filter(fn: (r) => ${fieldFilter})`

        queryApi.queryRows(query, {
            next(row, tableMeta) {
                const field = tableMeta.column('_field').get(row);
                byField[field].push({
                    _time: tableMeta.column('_time').get(row),
                    _value: tableMeta.column('_value').get(row)
                });
            },
            reject,
            complete() {
                resolve(byField);
            }
        });
    });
}

// Fetch several power fields over an absolute time range [start, stop] (Date
// objects or ISO strings) and resolve with an object mapping each tag to its
// point array. Used to compute energy for a single local calendar day.
function requestPowerOverRange(start, stop, tags) {
    const startISO = new Date(start).toISOString();
    const stopISO = new Date(stop).toISOString();
    return new Promise(function(resolve, reject) {
        const byField = {};
        tags.forEach(function (tag) {
            byField[tag] = [];
        });
        const fieldFilter = tags.map(function (tag) {
            return `r["_field"] == "${tag}"`;
        }).join(' or ');

        const query =
            `from(bucket: "${bucket}")
            |> range(start: ${startISO}, stop: ${stopISO})
            |> filter(fn: (r) => r["_measurement"] == "power")
            |> filter(fn: (r) => ${fieldFilter})`

        queryApi.queryRows(query, {
            next(row, tableMeta) {
                const field = tableMeta.column('_field').get(row);
                byField[field].push({
                    _time: tableMeta.column('_time').get(row),
                    _value: tableMeta.column('_value').get(row)
                });
            },
            reject,
            complete() {
                resolve(byField);
            }
        });
    });
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

// Graph-friendly power series, downsampled to a moving average. The window `every`
// can be passed explicitly (e.g. "5m") or, when omitted, chosen automatically from
// the period. Returns raw points when no window applies (short period / explicit
// "raw"). Use requestPowerOverPeriod for raw points (energy).
function requestPowerOverPeriodGraph(period, tag, every) {
    return new Promise(function(resolve, reject) {
        const window = every || getAggregateWindow(period);
        if (!window) {
            return requestPowerOverPeriod(period, tag).then(resolve, reject);
        }
        let csv = [];
        const query =
            `from(bucket: "${bucket}")
            |> range(start: -${period})
            |> filter(fn: (r) => r["_measurement"] == "power")
            |> filter(fn: (r) => r["_field"] == "${tag}")
            |> aggregateWindow(every: ${window}, fn: mean, createEmpty: false)`

        queryApi.queryRows(query, {
            next(row, tableMeta) {
                csv.push({
                    _time: tableMeta.column('_time').get(row),
                    _value: tableMeta.column('_value').get(row)
                });
            },
            reject,
            complete() {
                resolve(csv);
            }
        });
    });
}

// Serialize a points array ({_time, _value}) to CSV. Much lighter to transfer
// and parse than the equivalent JSON when graphing large series.
function pointsToCSV(points) {
    let out = '_time,_value';
    for (let i = 0; i < points.length; i++) {
        out += '\n' + points[i]._time + ',' + points[i]._value;
    }
    return out;
}

function requestVarOverPeriod(period, tag) {
    return new Promise(function(resolve, reject) {
        let csv = []
            const query = 
            `from(bucket: "${bucket}")
            |> range(start: -${period})
            |> filter(fn: (r) => r["_measurement"] == "var")
            |> filter(fn: (r) => r["_field"] == "${tag}")
            |> yield(name: "mean")`

            queryApi.queryRows(query, {
                next(row, tableMeta) {
                    o = tableMeta.toObject(row);
                    csv.push(o);
                },
                reject,
                complete() {
                    resolve(csv);
                }
            });
    });
}

function requestLastVar(tag) {
    return new Promise(function(resolve, reject) {
        let csv = []
            const query = 
            `from(bucket: "${bucket}")
            |> range(start: -1d)
            |> filter(fn: (r) => r["_measurement"] == "var")
            |> filter(fn: (r) => r["_field"] == "${tag}")
            |> last()`

            queryApi.queryRows(query, {
                next(row, tableMeta) {
                    o = tableMeta.toObject(row);
                    csv.push(o);
                },
                reject,
                complete() {
                    resolve(csv);
                }
            });
    });
}

function requestLastPower(tag) {
    return new Promise(function(resolve, reject) {
        let csv = []
            const query = 
            `from(bucket: "${bucket}")
            |> range(start: -1d)
            |> filter(fn: (r) => r["_measurement"] == "power")
            |> filter(fn: (r) => r["_field"] == "${tag}")
            |> last()`

            queryApi.queryRows(query, {
                next(row, tableMeta) {
                    o = tableMeta.toObject(row);
                    csv.push(o);
                },
                reject,
                complete() {
                    resolve(csv);
                }
            });
    });
}

function requestPowerOverPeriodGroupBy(period, tag, group) {
    return new Promise(function(resolve, reject) {
        let csv = []
            const query = 
            `from(bucket: "${bucket}")
            |> range(start: -${period})
            |> filter(fn: (r) => r["_measurement"] == "power")
            |> filter(fn: (r) => r["_field"] == "${tag}")
            |> aggregateWindow(fn: mean, every: ${group}, createEmpty: false)`

            queryApi.queryRows(query, {
                next(row, tableMeta) {
                    o = tableMeta.toObject(row);
                    csv.push(o);
                },
                reject,
                complete() {
                    resolve(csv);
                }
            });
    });
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
    createPowerWriter: createPowerWriter,
    createBatteryHistory: createBatteryHistory,
    writeBatteryLevel: writeBatteryLevel,
    requestBatteryLevelOverPeriod: requestBatteryLevelOverPeriod,
    writePower : writePower,
    writeVar: writeVar,
    daemon: daemon,
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
