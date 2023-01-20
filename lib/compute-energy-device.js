const influxLib = require('./influx-lib.js');

function getSimpleStats(startDate,endDate,data) {
    let sum = 0;

    const dataFiltred = data.filter(function (el) {
        let date = new Date(el._time);
        return (date >= startDate && date <= endDate);
    });

    dataFiltred.forEach(function(el,k) { 
        if (k+1 != dataFiltred.length) {
            b = new Date(dataFiltred[k+1]._time);
            a = new Date(el._time);
            delta = (b-a)/1000;
            sum += el._value*delta;
        }
    });
    return Math.floor(sum/(60*60));
}

function computeDeviceEnergy(data) {
    const startDate = new Date(data[0]._time);
    const endDate = new Date(data[data.length-1]._time);
    return getSimpleStats(startDate,endDate,data);
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
    console.log("Requesting data")
    getDeviceEnergy('24h', 'chauffe-eau', function (err, value) {
        if (err) {
            return console.error(err);
        }
        console.log("value:", value);
    })
}