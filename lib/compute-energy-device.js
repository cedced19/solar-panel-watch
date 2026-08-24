const influxLib = require('./influx-lib.js');
const config = require('../config.json');

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

// Fallback used when no point falls in the period: assume constant power.
function fallbackToLastPower(period, device_uri, cb) {
    influxLib.requestLastPower(device_uri).then(function (data) {
        const v = data.length ? data[0]._value : 0;
        cb(null, (v * influxPeriodToMS(period) / 1000) / 3600);
    }).catch(cb);
}

// Integrate the device power by streaming every point (O(1) memory, staircase
// integral, last sample extended up to "now"). Reference implementation.
function computeDeviceEnergyStream(period, device_uri, cb) {
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

        if (!hasData) return fallbackToLastPower(period, device_uri, cb);

        const tail = (now - prevT) / 1000;
        if (tail > 0) sum += prevV * tail;
        cb(null, sum / 3600);
    });
}

// Compute the energy directly in InfluxDB with integral() (trapezoidal, only
// over the existing points). O(1) data transfer. Returns a Promise<number>.
function computeDeviceEnergyIntegral(period, device_uri) {
    return influxLib.requestPowerIntegralOverPeriod(period, device_uri).then(function (value) {
        if (value == null) {
            return new Promise(function (resolve, reject) {
                fallbackToLastPower(period, device_uri, function (err, v) {
                    if (err) return reject(err);
                    resolve(v);
                });
            });
        }
        return value;
    });
}

// Compute the energy of a device, using the method configured in config.json
// ("integral" or "stream"). See computeDeviceEnergyIntegral / Stream.
function getDeviceEnergy(period, device_uri, cb) {
    if (config.energy_method === 'stream') {
        computeDeviceEnergyStream(period, device_uri, cb);
        return;
    }
    computeDeviceEnergyIntegral(period, device_uri).then(function (value) {
        cb(null, value);
    }, function (err) {
        cb(err);
    });
}

module.exports = getDeviceEnergy;
module.exports.computeDeviceEnergyStream = computeDeviceEnergyStream;
module.exports.computeDeviceEnergyIntegral = computeDeviceEnergyIntegral;

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
