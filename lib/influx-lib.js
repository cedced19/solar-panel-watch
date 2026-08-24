const {InfluxDB, Point} = require('@influxdata/influxdb-client');
const getInformations = require('./get-informations.js');
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

function writePowerRaw(debug, data) { 
    // write power from Shelly directly
    const writeApi = client.getWriteApi(org, bucket);
    writeApi.useDefaultTags({home: defaultTag});

    const point = new Point('power')
    .floatField('power1', data.emeters[0].power)
    .floatField('power2', data.emeters[1].power)
    writeApi.writePoint(point)
    writeApi
        .close()
        .then(() => {
            if (debug) {
                logWithDate('Data updated in InfluxDB.');
            }
        })
        .catch(e => {
            logWithDate('Failed at updating InfluxDB: cannot connect to db.');
            console.error(e);
        });
}

function writeNetworkData(debug, data) { 
    // write power from Shelly directly
    const writeApi = client.getWriteApi(org, bucket);
    writeApi.useDefaultTags({home: defaultTag});

    const point = new Point('power')
    .floatField('power1', data.emeters[0].power)
    .floatField('reactive1', data.emeters[0].reactive)
    .floatField('pf1', data.emeters[0].pf)
    .floatField('voltage1', data.emeters[0].voltage)
    .floatField('power2', data.emeters[1].power)
    .floatField('reactive2', data.emeters[1].reactive)
    .floatField('pf2', data.emeters[1].pf)
    .floatField('voltage2', data.emeters[1].voltage)
    writeApi.writePoint(point)
    writeApi
        .close()
        .then(() => {
            if (debug) {
                logWithDate('Data updated in InfluxDB.');
            }
        })
        .catch(e => {
            logWithDate('Failed at updating InfluxDB: cannot connect to db.');
            console.error(e);
        });
}

function daemon(debug, log_enabled) {
    getInformations.req(function (err, data) {
        if (err) {
            logWithDate('Failed at updating InfluxDB: no data from Shelly.');
            return console.error(err);
        } 
        if (log_enabled) {
            // log also data from network
            writeNetworkData(debug, data);
        } else {
            // simply log power
            writePowerRaw(debug, data);
        }
        
    });
}

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

// Graph-friendly power series: downsampled with an automatic window unless the
// period is short. Use requestPowerOverPeriod for raw points (energy).
function requestPowerOverPeriodGraph(period, tag) {
    return new Promise(function(resolve, reject) {
        const every = getAggregateWindow(period);
        if (!every) {
            return requestPowerOverPeriod(period, tag).then(resolve, reject);
        }
        let csv = [];
        const query =
            `from(bucket: "${bucket}")
            |> range(start: -${period})
            |> filter(fn: (r) => r["_measurement"] == "power")
            |> filter(fn: (r) => r["_field"] == "${tag}")
            |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)`

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
    requestPowerOverPeriodGraph: requestPowerOverPeriodGraph, 
    getAggregateWindow: getAggregateWindow, 
    pointsToCSV: pointsToCSV, 
    requestVarOverPeriod: requestVarOverPeriod, 
    requestPowerOverPeriodGroupBy: requestPowerOverPeriodGroupBy,
    writePowerRaw: writePowerRaw,
    getMaxValueOverData: getMaxValueOverData
};
