const {InfluxDB} = require('@influxdata/influxdb-client')

// organisation

// You can generate a Token from the "Tokens Tab" in the UI
const token = 'WB0HLKZwDBK_fBRF2kdXVrRtdwMJ-CxQy2BM2LxDRUqacZI9fxzFDH2VHXi61xc9Q0F6CNhJnYPs2v4w1BXzPQ=='
const org = 'cjung'
const bucket = 'test'

const client = new InfluxDB({url: 'http://192.168.0.62:8086', token: token})

const {Point} = require('@influxdata/influxdb-client')
const writeApi = client.getWriteApi(org, bucket)
writeApi.useDefaultTags({host: 'host1'})

const point = new Point('mem')
  .floatField('used_percent', 15.43234543)
writeApi.writePoint(point)
writeApi
    .close()
    .then(() => {
        console.log('\nFinished publish SUCCESS')
    })
    .catch(e => {
        console.error(e)
        console.log('\nFinished publish ERROR')
    })

    const queryApi = client.getQueryApi(org)

const query = `from(bucket: "${bucket}") |> range(start: -1h)`
    queryApi.queryRows(query, {
      next(row, tableMeta) {
        const o = tableMeta.toObject(row)
        //console.log(o)
        console.log(
          `${o._time} ${o._measurement} in '${o.host}' (${o._field}): ${o._field}=${o._value}\\`
        )
      },
      error(error) {
        console.error(error);
        console.log('\nFinished request ERROR');
      },
      complete() {
        console.log('\nFinished request SUCCESS');
      },
})