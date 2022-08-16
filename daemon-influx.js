const {InfluxDB} = require('@influxdata/influxdb-client');
const getInformations = require('./get-informations.js');
const config = require('./config.json');
// You can generate a Token from the "Tokens Tab" in the UI
const token = config.influx_tocken;
const org = config.influx_org;
const bucket = config.influx_bucket;
const defaultTag = config.influx_default_tag;

const client = new InfluxDB({url: 'http://localhost:8086', token: token})

const {Point} = require('@influxdata/influxdb-client')
const writeApi = client.getWriteApi(org, bucket)
writeApi.useDefaultTags({home: defaultTag})

getInformations(function (err, data) {
    if (err) return console.log(err);
    const point = new Point('power')
    .floatField('power1', data.emeters[0].power)
    .floatField('power2', data.emeters[1].power)
    writeApi.writePoint(point)
    writeApi
        .close()
        .then(() => {
            console.log('FINISHED')
        })
        .catch(e => {
            console.error(e)
            console.log('\nFinished ERROR')
        });
});