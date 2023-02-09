const influxLib = require('./influx-lib.js');

function computeDeviceEnergy(data) {
    data.push({_value: 0, _time: (new Date()).getTime()}); // in order to have the last value taken into account 
    
    let sum = 0;

    if (data.length == 0) {
        return 0;
    }

    data.forEach(function(el,k) { 
        if (k+1 != data.length) {
            b = new Date(data[k+1]._time);
            a = new Date(el._time);
            delta = (b-a)/1000;
            sum += el._value*delta;
        }
    });
    return Math.floor(sum/(60*60));
}

function getDeviceEnergy(period, device_uri, cb) {
    influxLib.requestDataOverPeriod(period, device_uri).then(function (data) {
        cb(null, computeDeviceEnergy(data));
    }).catch(cb);
}

module.exports = getDeviceEnergy;

if (typeof require !== 'undefined' && require.main === module) {
    const data = require('../data-device-3d.json');
    console.log("Pre-Downloaded data", computeDeviceEnergy(data));
    console.log("Requesting data");
    getDeviceEnergy('24h', 'chauffe-eau', function (err, value) {
        if (err) {
            return console.error(err);
        }
        console.log("value:", value);
    });
}
