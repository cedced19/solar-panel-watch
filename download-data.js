
const {InfluxDB} = require('@influxdata/influxdb-client');
const config = require('./config.json');
const fs = require('fs');

const token = config.influx_tocken;
const org = config.influx_org;
const bucket = config.influx_bucket;
const url = config.influx_url;
const client = new InfluxDB({url: url, token: token});
const queryApi = client.getQueryApi(org);

const requestData = function (period, tag) {
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

const promises = [requestData('5d', 'power1'), requestData('5d', 'power2')];

Promise.all(promises).then(function (results) {
    const data = JSON.stringify(results);
    fs.writeFileSync('data-5d.json', data);
}, function (error) {
    console.log(error);
});