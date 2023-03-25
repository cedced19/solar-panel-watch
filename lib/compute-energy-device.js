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

function getDeviceEnergy(period, device_uri, cb) {
    influxLib.requestPowerOverPeriod(period, device_uri).then(function (data) {
        if (data.length == 0) {
            influxLib.requestLastData(device_uri).then(function (data) {
                const modifiedData = [];
                modifiedData.push({ _value: data[0]._value, _time: (new Date()).getTime() - influxPeriodToMS(period) });
                cb(null, computeDeviceEnergy(modifiedData));
            });
        } else {
            cb(null, computeDeviceEnergy(data));
        }
        
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
