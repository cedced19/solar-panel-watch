// Saves the raw grid (power1) and solar (power2) readings of the last 5 days
// to data-5d.json, for offline analysis.
const victoriaLib = require('./lib/victoria-lib.js');
const fs = require('fs');

const promises = [victoriaLib.requestPowerOverPeriod('5d', 'power1'), victoriaLib.requestPowerOverPeriod('5d', 'power2')];

Promise.all(promises).then(function (results) {
    const data = JSON.stringify(results);
    fs.writeFileSync('data-5d.json', data);
}, function (error) {
    console.log(error);
});
