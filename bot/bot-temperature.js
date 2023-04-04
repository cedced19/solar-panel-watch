const http = require('http');
const querystring = require('querystring');

function getRandomNumber(min, max) {
  return Math.round((Math.random() * (max - min) + min)*1000)/1000;
}

// List of HTTP addresses and their respective timers
const addresses = [
  { method: 'GET', hostname: '127.0.0.1', port: 8889, path: '/api/device/id/QQqR9/advanced/', interval: 2500, name: 'Chauffe eau' },
  { method: 'GET', hostname: '127.0.0.1', port: 8889, path: '/api/device/id/1b9d8/advanced/', interval: 2500, name: 'Chauffe eau sanitaire' },
  { method: 'POST', hostname: '127.0.0.1', port: 8889, path: '/api/device/id/1b9d8/control-variable/', interval: 10000, name: 'Chauffe eau sanitaire - Temperature' },
];

// Loop through each address and set up a timer to call it at the specified interval
for (const address of addresses) {
  setInterval(() => {

    let body = '';

    if (address.method == 'POST') {
      body = querystring.stringify({ var: getRandomNumber(40,100) });
    }

    // Make the request
    const options = {
      hostname: address.hostname,
      host: address.hostname,
      path: address.path,
      port: address.port,
      method: address.method,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = http.request(options, (res) => {
      console.log(`${address.name}: Called server and got response ${res.statusCode}`);
    });

    req.on('error', (error) => {
      console.error(`Error calling server: ${error}`);
    });

    if (options.method == 'POST') {
      req.write(body);
    }
    req.end();
  }, address.interval);
}