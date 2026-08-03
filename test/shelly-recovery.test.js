const assert = require('node:assert/strict');
const test = require('node:test');

const {createGetInformations} = require('../lib/get-informations');
const {findShellyIpByMac, normalizeMacAddress} = require('../lib/shelly-recovery');

function response(body, statusCode = 200) {
    return {
        statusCode,
        getBody: () => JSON.stringify(body)
    };
}

function getInformation(client) {
    return new Promise((resolve, reject) => {
        client.req((err, data) => err ? reject(err) : resolve(data));
    });
}

test('normalizes supported MAC address formats', () => {
    assert.equal(normalizeMacAddress('34:94:54:70:F8:E2'), '34945470F8E2');
    assert.equal(normalizeMacAddress('34-94-54-70-f8-e2'), '34945470F8E2');
    assert.equal(normalizeMacAddress('34945470f8e2'), '34945470F8E2');
    assert.equal(normalizeMacAddress('not-a-mac'), null);
});

test('finds a Shelly on the configured /24 by its MAC address', async () => {
    const requestedHosts = [];
    const recoveredIp = await findShellyIpByMac({
        ipAddress: '192.168.40.92',
        macAddress: '34:94:54:70:F8:E2',
        concurrency: 8,
        requestFn: (method, url) => {
            const host = new URL(url).hostname;
            requestedHosts.push(host);
            if (host === '192.168.40.37') {
                return Promise.resolve(response({mac: '34945470f8e2'}));
            }
            return Promise.resolve(response({}, 404));
        }
    });

    assert.equal(recoveredIp, '192.168.40.37');
    assert.ok(requestedHosts.includes('192.168.40.37'));
});

test('uses the recovered IP without modifying the configured IP', async () => {
    const appConfig = {
        ip_adress_shelly: '192.168.0.92',
        shelly_req_threshold: 1000,
        recover_shelly_through_mac_address: true,
        shelly_mac_address: '34:94:54:70:F8:E2'
    };
    const requestedUrls = [];
    const client = createGetInformations({
        config: appConfig,
        requestFn: (method, url) => {
            requestedUrls.push(url);
            if (url === 'http://192.168.0.92/status') {
                return Promise.reject(new Error('unreachable'));
            }
            if (url === 'http://192.168.0.37/status') {
                return Promise.resolve(response({
                    unixtime: 1,
                    emeters: [{power: -400}, {power: 200}]
                }));
            }
            return Promise.reject(new Error('unexpected request'));
        },
        recoveryFinder: async (options) => {
            assert.equal(options.macAddress, '34945470F8E2');
            assert.equal(options.ipAddress, '192.168.0.92');
            assert.equal(options.timeout, 250);
            return '192.168.0.37';
        }
    });

    const data = await getInformation(client);
    assert.equal(data.emeters[0].power, -400);
    assert.equal(appConfig.ip_adress_shelly, '192.168.0.92');
    assert.deepEqual(requestedUrls, [
        'http://192.168.0.92/status',
        'http://192.168.0.37/status'
    ]);
    assert.equal(client.getRecoveryState().recoveredIp, '192.168.0.37');
});
