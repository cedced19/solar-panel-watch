const http = require('http');

// List of HTTP addresses and their respective timers
const addresses = [
  { hostname: '127.0.0.1', port: 8889, path: '/api/device/id/QQqR9/advanced/', interval: 2500, name: 'Chauffe eau' },
  { hostname: '127.0.0.1', port: 8889, path: '/api/device/id/1b9d8/advanced/', interval: 2500, name: 'Chauffe eau sanitaire' },
];

// Loop through each address and set up a timer to call it at the specified interval
for (const address of addresses) {
  setInterval(() => {
    // Make the request
    const options = {
      hostname: address.hostname,
      host: address.hostname,
      path: address.path,
      port: address.port,
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      console.log(`${address.name}: Called server and got response ${res.statusCode}`);
    });

    req.on('error', (error) => {
      console.error(`Error calling server: ${error}`);
    });

    req.end();
  }, address.interval);
}