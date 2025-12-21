/*
File to estimate energy saved by routing
*/

const data = require('../devices-activation.json');

const req_params = {
    uri: 'chauffe-eau', // device name
    power: 500 // power in W
}

data.filter(function (el) {
    return el.uri == req_params.uri;
});

if (data[0].activated == true) {
    data.shift();
}

let totalTime = 0;
for (let i = 0; i < data.length; i+=2) {
    totalTime += data[i+1].time - data[i].time
}
let energy = totalTime * req_params.power / 3600 / 1000 / 1000;
console.log('Energy saved by routing: ', Math.floor(energy), 'kWh');