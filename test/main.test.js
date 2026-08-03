const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const main = require('../main');
const getInformations = require('../lib/get-informations');

function request(server, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1',
            port: server.address().port,
            path,
            headers
        }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => {
                resolve({status: response.statusCode, body});
            });
        });
        request.on('error', reject);
        request.end();
    });
}

test('Shelly failures disable device decisions and show a translated configuration page', async (t) => {
    const server = await new Promise((resolve) => {
        const listeningServer = main.app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    const originalRequest = getInformations.req;

    t.after(() => {
        getInformations.req = originalRequest;
        server.close();
    });

    getInformations.req = (callback) => callback(new Error('Shelly is unreachable'));

    const unavailablePage = await request(server, '/', {'accept-language': 'fr'});
    assert.equal(unavailablePage.status, 503);
    assert.match(unavailablePage.body, /Le Shelly est indisponible/);
    assert.match(unavailablePage.body, /Impossible de lire les données de la Shelly/);
    assert.match(unavailablePage.body, /Données de puissance indisponibles/);
    assert.equal(main.isPowerDataAvailable(), false);

    const dataResponse = await request(server, '/api/data');
    assert.equal(dataResponse.status, 503);
    assert.deepEqual(JSON.parse(dataResponse.body), {error: 'Shelly data is unavailable.'});

    const normalById = await request(server, '/api/device/id/QQqR9/');
    assert.equal(normalById.status, 200);
    assert.deepEqual(JSON.parse(normalById.body), {toggle: false, time_limit: 2500});

    const normalByName = await request(server, '/api/device/chauffe-eau/');
    assert.equal(normalByName.status, 200);
    assert.deepEqual(JSON.parse(normalByName.body), {toggle: false, time_limit: 2500});

    const advancedById = await request(server, '/api/device/id/QQqR9/advanced/');
    assert.equal(advancedById.status, 200);
    assert.deepEqual(JSON.parse(advancedById.body), {alpha: 128, time_limit: 2500});

    const advancedByName = await request(server, '/api/device/chauffe-eau/advanced/');
    assert.equal(advancedByName.status, 200);
    assert.deepEqual(JSON.parse(advancedByName.body), {alpha: 128, time_limit: 2500});

    getInformations.req = (callback) => callback(null, {
        emeters: [{power: -500}, {power: 100}]
    });

    const availablePage = await request(server, '/');
    assert.equal(availablePage.status, 200);
    assert.match(availablePage.body, /-500/);
    assert.equal(main.isPowerDataAvailable(), true);

    getInformations.req = (callback) => callback(new Error('Shelly is unreachable again'));
    await request(server, '/');
    assert.equal(main.isPowerDataAvailable(), false);
});
