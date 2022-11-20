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

function daemon(debug) {
    const writeApi = client.getWriteApi(org, bucket);
    writeApi.useDefaultTags({home: defaultTag});

    getInformations.req(function (err, data) {
        if (err) return console.log(err);
        const point = new Point('power')
        .floatField('power1', data.emeters[0].power)
        .floatField('power2', data.emeters[1].power)
        writeApi.writePoint(point)
        writeApi
            .close()
            .then(() => {
                if (debug) {
                    console.log('Data updated in InfluxDB.');
                }
            })
            .catch(e => {
                console.error(e);
                console.log('\nFailed at updating InfluxDB.');
            });
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
                console.log('Data updated in InfluxDB.');
            }
        })
        .catch(e => {
            console.error(e);
            console.log('\nFailed at updating InfluxDB.');
        });
}

function requestDataOverPeriod(period, tag) {
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

function requestDataOverPeriodGroupBy(period, tag, group) {
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

module.exports = {writePower : writePower, daemon: daemon, requestDataOverPeriod: requestDataOverPeriod, requestDataOverPeriodGroupBy: requestDataOverPeriodGroupBy};