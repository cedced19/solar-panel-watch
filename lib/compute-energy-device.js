const influxLib = require('./influx-lib.js');

// Fast no-allocation integration of power points (W·s) -> energy.
// `points` is an array of {t: timestampMs, v: watts} sorted ascending.
// Staircase integral, last sample extended up to `now`.
function computeDeviceEnergy(points) {
    const n = points.length;
    if (n === 0) return 0;

    const now = Date.now();
    let sum = 0;
    let prevT = points[0].t;
    let prevV = points[0].v;

    for (let k = 1; k < n; k++) {
        const t = points[k].t;
        const delta = (t - prevT) / 1000;
        if (delta > 0) sum += prevV * delta;
        prevT = t;
        prevV = points[k].v;
    }

    // extend the last sample until "now" so the trailing energy is counted
    const tail = (now - prevT) / 1000;
    if (tail > 0) sum += prevV * tail;

    return sum / 3600; // Wh
}

function influxPeriodToMS(period) {
    const unit = period.slice(-1);  // get the last character of the string (the unit)
    const value = parseInt(period.slice(0, -1));  // get all but the last character (the value) and convert to integer
    let ms = 1;  // default to milliseconds
  
    // check the unit and convert to milliseconds
    switch (unit) {
      case 's':
        ms = 1000;
        break;
      case 'm':
        ms = 1000 * 60;
        break;
      case 'h':
        ms = 1000 * 60 * 60;
        break;
      case 'd':
        ms = 1000 * 60 * 60 * 24;
        break;
      case 'w':
        ms = 1000 * 60 * 60 * 24 * 7;
        break;
      case 'y':
        ms = 1000 * 60 * 60 * 24 * 365;
        break;
    }
  
    return value * ms;
}

// Compute the energy consumed by a device over a period by streaming the
// InfluxDB points (O(1) memory). Falls back to the last recorded power when
// no point exists over the period.
function getDeviceEnergy(period, device_uri, cb) {
    const now = Date.now();
    let sum = 0;
    let prevT = null;
    let prevV = null;
    let hasData = false;

    influxLib.streamPowerOverPeriod(period, device_uri, function (t, v) {
        if (prevT !== null) {
            const delta = (t - prevT) / 1000;
            if (delta > 0) sum += prevV * delta;
        }
        prevT = t;
        prevV = v;
        hasData = true;
    }, function (err) {
        if (err) return cb(err);

        if (!hasData) {
            // No data over the period: assume constant power over it.
            influxLib.requestLastPower(device_uri).then(function (data) {
                const v = data.length ? data[0]._value : 0;
                cb(null, (v * influxPeriodToMS(period) / 1000) / 3600);
            }).catch(cb);
            return;
        }

        const tail = (now - prevT) / 1000;
        if (tail > 0) sum += prevV * tail;
        cb(null, sum / 3600);
    });
}

module.exports = getDeviceEnergy;

if (typeof require !== 'undefined' && require.main === module) {
    // +/- 6 days of a constant 1500 W load, one point every 10 minutes
    const start = Date.now() - 6 * 24 * 3600 * 1000;
    const points = [];
    for (let t = start; t <= Date.now(); t += 10 * 60 * 1000) {
        points.push({ t, v: 1500 });
    }
    console.log("Pre-Downloaded data", computeDeviceEnergy(points));
    getDeviceEnergy('24h', 'chauffe-eau', function (err, value) {
        if (err) {
            return console.error(err);
        }
        console.log("value:", value);
    });
}
