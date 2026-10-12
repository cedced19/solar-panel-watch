'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {createZendureClient, validatePowerReport, validateBatteryReport, requestJson} = require('../lib/zendure');
const {findZendureIpByMac, findIpInNeighbors, normalizeMacAddress} = require('../lib/zendure-recovery');

const meterSerial = 'TEE1NJP7P341978';
const deviceSerial = 'ANACVCDLP283458';
const batterySerial = 'BEAAVCDLA283460';
const macAddress = 'E0:72:A1:85:24:48';
const batteryReport = {
    sn: deviceSerial,
    properties: {electricLevel: 86, outputPackPower: 900, packInputPower: 0, packState: 1, dataReady: 1},
    packData: [{sn: batterySerial, socLevel: 86, state: 1, power: 829}]
};

function response(json, statusCode = 200) {
    return {statusCode, json};
}

test('meter validation preserves flat and nested signed watts, zero and configured scaling', () => {
    assert.deepEqual(validatePowerReport({total_power: -1503}, {serial: meterSerial}), {
        power: -1503, serial: null, serialMatches: null
    });
    assert.equal(validatePowerReport({sn: meterSerial, properties: {total_power: 0}}, {serial: meterSerial}).serialMatches, true);
    assert.equal(validatePowerReport({properties: {gridPower: -1250}}, {powerField: 'gridPower', powerScale: -0.1}).power, 125);
    for (const value of ['100', null, false, NaN, Infinity]) {
        assert.throws(() => validatePowerReport({total_power: value}), /valid total_power/);
    }
    for (const powerScale of ['1', 0, NaN, Infinity]) {
        assert.throws(() => validatePowerReport({total_power: 20}, {powerScale}), /powerScale/);
    }
    assert.throws(() => validatePowerReport({total_power: Number.MAX_VALUE}, {powerScale: 2}), /valid total_power/);
});

test('readings reject wrong device serials, unready data and unrelated payloads', () => {
    for (const report of [undefined, null, [], 'page', {properties: []}, {error: 'offline'}]) {
        assert.throws(() => validatePowerReport(report));
        assert.throws(() => validateBatteryReport(report));
    }
    assert.throws(() => validatePowerReport({sn: 'OTHER', total_power: 100}, {serial: meterSerial}), /serial mismatch/);
    assert.throws(() => validateBatteryReport({...batteryReport, sn: 'OTHER'}, {serial: deviceSerial}), /serial mismatch/);
    for (const dataReady of [0, false, '0', '1', null, 2]) {
        assert.throws(() => validatePowerReport({total_power: 100, dataReady}), /not ready/);
        assert.throws(() => validateBatteryReport({...batteryReport, properties: {...batteryReport.properties, dataReady}}), /not ready/);
    }
});

test('battery validation selects the configured pack exactly, and falls back to aggregate SOC', () => {
    const options = {serial: deviceSerial, batterySerial};
    const reading = validateBatteryReport({...batteryReport, packData: [
        {sn: 'OTHER', socLevel: 99, state: 2, power: 500},
        {sn: batterySerial, socLevel: 0, state: 0, power: 0}
    ]}, options);
    assert.equal(reading.socPercent, 0);
    assert.equal(reading.socSource, 'packData.socLevel');
    assert.equal(reading.aggregateSocPercent, 86);
    assert.equal(reading.state, 'standby');
    assert.equal(reading.battery.powerW, 0);
    assert.equal(reading.chargingPowerW, 900);
    assert.equal(reading.dischargingPowerW, 0);
    assert.equal(reading.serialMatches, true);
    assert.equal(reading.batterySerialMatches, true);
    const fallback = validateBatteryReport({...batteryReport, packData: [{sn: 'OTHER', socLevel: 99}]}, options);
    assert.equal(fallback.socPercent, 86);
    assert.equal(fallback.socSource, 'electricLevel');
    assert.equal(fallback.batterySerialMatches, false);
    assert.equal(fallback.battery, null);
    assert.equal(fallback.state, 'charging');
    const nested = validateBatteryReport({properties: {packData: [{sn: batterySerial, socLevel: 100, state: 2}]}}, options);
    assert.equal(nested.socPercent, 100);
    assert.equal(nested.state, 'discharging');
    assert.equal(nested.serialMatches, null);
    assert.equal(validateBatteryReport({electricLevel: 0}).socPercent, 0);
    assert.equal(validateBatteryReport(batteryReport).socSource, 'electricLevel');
});

test('invalid pack SOC uses a valid aggregate but never another pack or a charge target', () => {
    for (const value of ['86', null, false, -1, 101, NaN, Infinity]) {
        const report = {...batteryReport, properties: {...batteryReport.properties, electricLevel: value}, packData: [{sn: batterySerial, socLevel: value}]};
        assert.throws(() => validateBatteryReport(report, {batterySerial}), /valid battery charge/);
        assert.equal(validateBatteryReport({...report, properties: {electricLevel: 50}}, {batterySerial}).socPercent, 50);
    }
    assert.throws(() => validateBatteryReport({packData: [{sn: 'OTHER', socLevel: 99}]}, {batterySerial}), /valid battery charge/);
    assert.throws(() => validateBatteryReport({socSet: 100}), /valid battery charge/);
    const invalidOptionalFields = validateBatteryReport({electricLevel: 50, packState: 3, outputPackPower: '900', packInputPower: -1});
    assert.equal(invalidOptionalFields.state, null);
    assert.equal(invalidOptionalFields.chargingPowerW, null);
    assert.equal(invalidOptionalFields.dischargingPowerW, null);
});

test('client shares concurrent requests, preserves receipt time and polls at the threshold', async () => {
    let calls = 0;
    let currentTime = 1700000000000;
    let release;
    const client = createZendureClient({
        host: '192.168.0.48', requestThreshold: 20000, now: () => currentTime,
        requestFn: async (url, timeout) => {
            calls++;
            assert.equal(url, 'http://192.168.0.48/properties/report');
            assert.equal(timeout, 3000);
            if (calls === 1) await new Promise(resolve => { release = resolve; });
            return response({total_power: 0, electricLevel: 0, timestamp: 1});
        }
    });
    const first = client.getPower();
    const second = client.getPower();
    const battery = client.getBattery();
    assert.equal(calls, 1);
    release();
    const readings = await Promise.all([first, second, battery]);
    assert.equal(readings[0].power, 0);
    assert.equal(readings[2].socPercent, 0);
    assert.equal(readings[0].time, 1700000000);
    currentTime += 19999;
    assert.equal((await client.getPower()).time, 1700000000);
    assert.equal(calls, 1);
    currentTime++;
    assert.equal((await client.getPower()).time, 1700000020);
    assert.equal(calls, 2);
});

test('client caches failures and clears old readings until a successful refresh', async () => {
    let currentTime = 0;
    let calls = 0;
    const client = createZendureClient({
        host: '192.168.0.48', now: () => currentTime,
        requestFn: async () => {
            calls++;
            if (calls === 2) throw new Error('Device offline');
            return response({total_power: calls * 100});
        }
    });
    assert.equal((await client.getPower()).power, 100);
    currentTime = 1000;
    await assert.rejects(client.getPower(), /Device offline/);
    currentTime = 1999;
    await assert.rejects(client.getPower(), /Device offline/);
    assert.equal(calls, 2);
    currentTime = 2000;
    assert.equal((await client.getPower()).power, 300);
    assert.equal(calls, 3);
});

test('polling thresholds measure request starts so response latency does not skip a scheduled poll', async () => {
    for (const requestThreshold of [1000, 20000]) {
        for (const failFirstRequest of [false, true]) {
            let currentTime = 1700000000900;
            let calls = 0;
            const client = createZendureClient({
                host: '192.168.0.48', requestThreshold, now: () => currentTime,
                requestFn: async () => {
                    calls++;
                    currentTime += 100;
                    if (failFirstRequest && calls === 1) throw new Error('Offline');
                    return response({total_power: 50});
                }
            });
            if (failFirstRequest) await assert.rejects(client.getPower(), /Offline/);
            else assert.equal((await client.getPower()).time, 1700000001);
            currentTime = 1700000000900 + requestThreshold;
            assert.equal((await client.getPower()).power, 50);
            assert.equal(calls, 2);
        }
    }
});

test('malformed measurements are throttled and callbacks report errors without stale data', async () => {
    let currentTime = 0;
    let calls = 0;
    const client = createZendureClient({
        host: '192.168.0.48', now: () => currentTime,
        requestFn: async () => { calls++; return response(calls === 1 ? {total_power: 10, electricLevel: 86} : {total_power: 'bad', electricLevel: 101}); }
    });
    assert.equal((await new Promise((resolve, reject) => client.reqPower((error, value) => error ? reject(error) : resolve(value)))).power, 10);
    assert.equal((await new Promise((resolve, reject) => client.reqBattery((error, value) => error ? reject(error) : resolve(value)))).socPercent, 86);
    assert.equal(calls, 1);
    currentTime = 1000;
    const failed = await new Promise(resolve => client.reqPower((error, value) => resolve({error, value})));
    assert.match(failed.error.message, /valid total_power/);
    assert.equal(failed.value, undefined);
    await assert.rejects(client.getBattery(), /valid/);
    await assert.rejects(client.getPower(), /valid total_power/);
    assert.equal(calls, 2);
});

test('MAC recovery retries the report and retains the verified new address', async () => {
    const hosts = [];
    let recoveries = 0;
    const client = createZendureClient({
        host: '192.168.0.48', serial: meterSerial, macAddress, recoverByMac: true, requestThreshold: 0,
        requestFn: async url => {
            const host = new URL(url).hostname;
            hosts.push(host);
            if (host.endsWith('.48')) throw new Error('Offline');
            return response({sn: meterSerial, properties: {total_power: -500}});
        },
        recoveryFinder: async options => {
            recoveries++;
            assert.deepEqual(options, {host: '192.168.0.48', macAddress, timeout: 250, port: 80});
            return {host: '192.168.0.37'};
        }
    });
    assert.equal((await client.getPower()).power, -500);
    assert.equal((await client.getPower()).serialMatches, true);
    assert.deepEqual(hosts, ['192.168.0.48', '192.168.0.37', '192.168.0.37']);
    assert.equal(recoveries, 1);
    assert.equal(client.getRecoveryState().recoveredIp, '192.168.0.37');
});

test('MAC recovery rejects unrelated JSON and missing requested measurements before retaining an address', async () => {
    for (const kind of ['Power', 'Battery']) {
        for (const invalidReport of [{}, {error: 'offline'}, {socSet: 100}, {properties: {electricLevel: 101, total_power: '100'}}]) {
            const hosts = [];
            const client = createZendureClient({
                host: '192.168.0.48', macAddress, recoverByMac: true,
                requestFn: async url => {
                    const host = new URL(url).hostname;
                    hosts.push(host);
                    return response(host.endsWith('.48') ? invalidReport : {total_power: -500, electricLevel: 86});
                },
                recoveryFinder: async () => ({host: '192.168.0.37'})
            });
            const reading = await client['get' + kind]();
            assert.equal(kind === 'Power' ? reading.power : reading.socPercent, kind === 'Power' ? -500 : 86);
            assert.deepEqual(hosts, ['192.168.0.48', '192.168.0.37']);
            assert.equal(client.getRecoveryState().recoveredIp, '192.168.0.37');
        }
    }
});

test('MAC retries wait at least 60 seconds and denied sockets skip discovery', async () => {
    let currentTime = 0;
    let recoveries = 0;
    const client = createZendureClient({
        host: '192.168.0.48', macAddress, recoverByMac: true, requestThreshold: 0, recoveryInterval: 1, now: () => currentTime,
        requestFn: async () => { throw new Error('Offline'); },
        recoveryFinder: async () => { recoveries++; return {host: null, unavailable: true}; }
    });
    await assert.rejects(client.getPower(), /Offline/);
    assert.equal(client.getRecoveryState().attempted, true);
    assert.equal(client.getRecoveryState().notFound, true);
    assert.equal(client.getRecoveryState().unavailable, true);
    currentTime = 59999;
    await assert.rejects(client.getPower(), /Offline/);
    assert.equal(recoveries, 1);
    currentTime = 60000;
    await assert.rejects(client.getPower(), /Offline/);
    assert.equal(recoveries, 2);
    const denied = createZendureClient({
        host: '192.168.0.48', macAddress, recoverByMac: true,
        requestFn: async () => { throw Object.assign(new Error('Denied'), {code: 'EPERM'}); },
        recoveryFinder: async () => { throw new Error('Unexpected discovery'); }
    });
    await assert.rejects(denied.getPower(), /Denied/);
    assert.equal(denied.getRecoveryState().attempted, false);
});

test('wrong-serial recovery reports never replace the active address', async () => {
    const client = createZendureClient({
        host: '192.168.0.48', serial: meterSerial, macAddress, recoverByMac: true,
        requestFn: async url => response({sn: new URL(url).hostname.endsWith('.37') ? 'OTHER' : meterSerial, properties: {total_power: 5, dataReady: 0}}),
        recoveryFinder: async () => ({host: '192.168.0.37'})
    });
    await assert.rejects(client.getPower(), /serial mismatch/);
    assert.equal(client.getRecoveryState().recoveredIp, null);
});

test('construction rejects invalid configuration while negative scales and explicit ports work', () => {
    for (const options of [
        {}, {host: ''}, {host: 'http://device'}, {host: 'device/path'}, {host: 'device', port: 0},
        {host: 'device', serial: ''}, {host: 'device', powerScale: 0}, {host: 'device', powerScale: '1'},
        {host: 'device', timeout: 0}, {host: 'device', requestThreshold: -1},
        {host: 'device', recoverByMac: true, macAddress: 'invalid'}
    ]) assert.throws(() => createZendureClient(options));
    assert.ok(createZendureClient({host: 'device:8000', requestThreshold: 0, powerScale: -1}));
});

test('neighbor recovery matches only the exact MAC in the configured subnet', async () => {
    assert.equal(normalizeMacAddress('e072a1852448'), macAddress);
    assert.equal(normalizeMacAddress('e0-72-a1-85-24-48'), macAddress);
    assert.equal(normalizeMacAddress('not-e0:72:a1:85:24:48'), null);
    const neighbors = `192.168.1.37 dev eth0 lladdr ${macAddress} REACHABLE\n192.168.0.37 dev eth0 lladdr ${macAddress} STALE`;
    assert.equal(findIpInNeighbors(neighbors, macAddress, '192.168.0.48'), '192.168.0.37');
    assert.equal(findIpInNeighbors(`192.168.0.37 dev eth0 lladdr ${macAddress} FAILED`, macAddress, '192.168.0.48'), null);
    let reads = 0;
    const probes = [];
    const result = await findZendureIpByMac({host: '192.168.0.48', macAddress, timeout: 3000}, {
        readNeighbors: async () => ++reads === 1 ? '' : `192.168.0.37 dev eth0 lladdr ${macAddress} REACHABLE`,
        probeTcp: async (host, port, timeout) => {
            probes.push({host, port, timeout});
            return {open: false, error: 'ECONNREFUSED'};
        }
    });
    assert.deepEqual(result, {host: '192.168.0.37'});
    assert.equal(probes.length, 16);
    assert.ok(probes.every(probe => probe.host.startsWith('192.168.0.') && probe.port === 80 && probe.timeout === 250));
    assert.deepEqual(await findZendureIpByMac({host: '192.168.0.48', macAddress}, {readNeighbors: async () => null}), {host: null, unavailable: true});
});

async function fixture(t, handler) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    return {host: '127.0.0.1', port: server.address().port, url: `http://127.0.0.1:${server.address().port}/properties/report`};
}

test('real HTTP client requests only the LAN report and serves both callback methods', async t => {
    const requests = [];
    const options = await fixture(t, (request, result) => {
        requests.push({method: request.method, path: request.url});
        result.setHeader('Content-Type', 'application/json');
        result.end(JSON.stringify({...batteryReport, properties: {...batteryReport.properties, total_power: -50}}));
    });
    const client = createZendureClient({...options, serial: deviceSerial, batterySerial});
    assert.equal((await client.getPower()).power, -50);
    assert.equal((await client.getBattery()).socPercent, 86);
    assert.deepEqual(requests, [{method: 'GET', path: '/properties/report'}]);
});

test('HTTP errors, invalid JSON, oversized and interrupted reports are unavailable', async t => {
    for (const scenario of ['status', 'json', 'oversize', 'interrupted']) {
        await t.test(scenario, async t => {
            const options = await fixture(t, (_request, result) => {
                if (scenario === 'status') result.writeHead(401);
                if (scenario === 'json') return result.end('<html>Error</html>');
                if (scenario === 'oversize') return result.end('x'.repeat(70000));
                if (scenario === 'interrupted') {
                    result.writeHead(200, {'Content-Length': '100'});
                    result.write('{');
                    return setImmediate(() => result.destroy());
                }
                result.end(JSON.stringify({total_power: 100}));
            });
            const client = createZendureClient({...options, timeout: 500});
            await assert.rejects(client.getPower());
        });
    }
});

test('HTTP deadline covers a continuously streaming response', async t => {
    const options = await fixture(t, (_request, result) => {
        result.writeHead(200);
        result.write('{');
        const interval = setInterval(() => result.write(' '), 10);
        result.once('close', () => clearInterval(interval));
    });
    await assert.rejects(requestJson(options.url, 80), {code: 'ETIMEDOUT'});
});
