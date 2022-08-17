const {InfluxDB, Point} = require('@influxdata/influxdb-client');
const getInformations = require('./get-informations.js');
const config = require('./config.json');

const token = config.influx_tocken;
const org = config.influx_org;
const bucket = config.influx_bucket;
const defaultTag = config.influx_default_tag;

const client = new InfluxDB({url: 'http://localhost:8086', token: token});

function write(debug) {
    const writeApi = client.getWriteApi(org, bucket);
    writeApi.useDefaultTags({home: defaultTag});

    getInformations(function (err, data) {
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

module.exports = write;