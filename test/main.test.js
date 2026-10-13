const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const vm = require('node:vm');

const main = require('../main');
const getPowerData = require('../lib/get-power-data');
const config = require('../config.json');
const minSocPercent = config.zendure_battery_min_soc ?? 80;
const healthyBatteryDecision = {
    enabled: 86 > minSocPercent,
    reason: 86 > minSocPercent ? 'soc-above-threshold' : 'soc-at-or-below-threshold',
    minSocPercent,
    socPercent: 86
};

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

test('the dashboard reports Zendure house power and battery availability independently', async (t) => {
    const server = await new Promise((resolve) => {
        const listeningServer = main.app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    const originals = {...getPowerData};
    let recoveryState = {
        enabled: true,
        notFound: true,
        macAddress: 'E0:72:A1:85:24:48'
    };

    t.after(() => {
        Object.assign(getPowerData, originals);
        server.close();
    });

    getPowerData.req = (callback) => callback(new Error('Zendure is unreachable'));
    getPowerData.getHousePowerSource = () => 'zendure';
    getPowerData.getHouseRecoveryState = () => recoveryState;
    getPowerData.getShellyRecoveryState = () => ({});
    getPowerData.reqBattery = (callback) => callback(null, {
        socPercent: 86, state: 'charging', socSource: 'packData.socLevel', chargingPowerW: 345, dischargingPowerW: 300
    });

    const unavailablePage = await request(server, '/', {'accept-language': 'fr'});
    assert.equal(unavailablePage.status, 503);
    assert.match(unavailablePage.body, /Zendure.*indisponible/i);
    assert.match(unavailablePage.body, /E0:72:A1:85:24:48/);
    assert.match(unavailablePage.body, /Puissance de la maison indisponible/);
    assert.match(unavailablePage.body, /Impossible de lire la puissance de la maison depuis le capteur Zendure/);
    assert.equal(main.isPowerDataAvailable(), false);

    const dataResponse = await request(server, '/api/data');
    assert.equal(dataResponse.status, 503);
    assert.deepEqual(JSON.parse(dataResponse.body), {
        error: 'Zendure house power data is unavailable.',
        device_charging: {
            enabled: false, reason: 'power-unavailable', minSocPercent, socPercent: 86
        }
    });

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

    getPowerData.req = (callback) => callback(null, {
        emeters: [{power: -500}, {power: 1000}]
    });
    recoveryState = {recoveredIp: '192.168.0.37'};

    const availablePage = await request(server, '/');
    assert.equal(availablePage.status, 200);
    assert.match(availablePage.body, /-500/);
    assert.match(availablePage.body, /192.168.0.37/);
    assert.match(availablePage.body, /id="battery-level"/);
    assert.match(availablePage.body, /86/);
    assert.match(availablePage.body, /Battery charging power/);
    assert.match(availablePage.body, /id="battery-charging-power">345<\/span>/);
    assert.match(availablePage.body, /id="battery-discharging-power">300<\/span>/);
    assert.match(availablePage.body, /id="total-production">455<\/span>/);
    assert.equal(main.isPowerDataAvailable(), true);

    const powerResponse = await request(server, '/api/data');
    assert.deepEqual(JSON.parse(powerResponse.body), {
        power1: -500, power2: 1000, house_power_source: 'zendure',
        power_activated_device: 0,
        device_charging: healthyBatteryDecision,
        device_states: {}
    });
    const batteryResponse = await request(server, '/api/battery');
    assert.equal(batteryResponse.status, 200);
    assert.equal(JSON.parse(batteryResponse.body).socPercent, 86);
    assert.equal(JSON.parse(batteryResponse.body).chargingPowerW, 345);

    // Rendered polling scripts must compile, including translated labels.
    for (const script of availablePage.body.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        new vm.Script(script[1]);
    }

    getPowerData.reqBattery = (callback) => callback(null, {
        socPercent: 86, state: 'standby', chargingPowerW: 0, dischargingPowerW: 0
    });
    const zeroChargePowerPage = await request(server, '/');
    assert.match(zeroChargePowerPage.body, /id="battery-charging-power">0<\/span>/);
    getPowerData.reqBattery = (callback) => callback(null, {socPercent: 86, state: 'standby', chargingPowerW: 345});
    const missingChargePowerPage = await request(server, '/');
    assert.match(missingChargePowerPage.body, /id="battery-discharging-power">Unavailable<\/span>/);
    assert.match(missingChargePowerPage.body, /id="total-production">500<\/span>/);

    getPowerData.reqBattery = (callback) => callback(new Error('Battery is unreachable'));
    const unavailableBattery = await request(server, '/api/battery');
    assert.equal(unavailableBattery.status, 503);
    assert.deepEqual(JSON.parse(unavailableBattery.body), {
        error: 'Zendure battery data is unavailable.',
        device_charging: {
            enabled: false, reason: 'battery-unavailable', minSocPercent, socPercent: null
        }
    });
    const pageWithoutBattery = await request(server, '/');
    assert.equal(pageWithoutBattery.status, 200);
    assert.match(pageWithoutBattery.body, /Unavailable/);
    assert.equal(main.isPowerDataAvailable(), true);

    getPowerData.req = (callback) => callback(new Error('Zendure is unreachable again'));
    await request(server, '/');
    assert.equal(main.isPowerDataAvailable(), false);

    // An explicit Shelly source still gets the existing translated error page.
    getPowerData.getHousePowerSource = () => 'shelly';
    recoveryState = {enabled: true, notFound: true, macAddress: '34:94:54:70:F8:E2'};
    const shellyError = await request(server, '/', {'accept-language': 'fr'});
    assert.equal(shellyError.status, 503);
    assert.match(shellyError.body, /Le Shelly est indisponible/);
    assert.match(shellyError.body, /34:94:54:70:F8:E2/);
});
