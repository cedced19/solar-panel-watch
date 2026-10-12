'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const path = require('node:path');
const {parseArgs, inspectBatteryReport, probeHost, main} = require('../try-zendure-battery');

const serial = 'ANACVCDLP283458';
const batterySerial = 'BEAAVCDLA283460';
// Relevant fields observed from the supplied SolarFlow 3000 MIX AC+ on its LAN.
const liveReport = {
    sn: serial,
    product: 'solarFlow3000MixAC+',
    properties: {electricLevel: 86, outputPackPower: 900, packInputPower: 0, packState: 1, dataReady: 1},
    packData: [{sn: batterySerial, socLevel: 86, state: 1, power: 829}]
};

async function runCli(args) {
    const child = spawn(process.execPath, [path.join(__dirname, '../try-zendure-battery.js'), '--no-mac-fallback', ...args], {
        env: {...process.env, ZENDURE_KEY: ''}
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    return {code, stdout, stderr};
}

async function capture(run) {
    const lines = [];
    const original = console.log;
    console.log = line => lines.push(line);
    try { return {result: await run(), output: lines.join('\n')}; }
    finally { console.log = original; }
}

test('battery options use the supplied device and pack identities', () => {
    const options = parseArgs([]);
    assert.equal(options.host, '192.168.0.40');
    assert.equal(options.serial, serial);
    assert.equal(options.id, '492766');
    assert.equal(options.mac, '90:64:9B:10:9A:14');
    assert.equal(options.batterySerial, batterySerial);
    assert.equal(options.macFallback, true);
    const custom = parseArgs(['--host', '127.0.0.1', '--battery-serial', 'OTHER', '--ports', '80,80', '--no-mac-fallback']);
    assert.equal(custom.batterySerial, 'OTHER');
    assert.deepEqual(custom.ports, [80]);
    assert.equal(custom.macFallback, false);
    for (const args of [['--battery-serial'], ['--battery-serial', '--cloud'], ['--host'], ['--timeout', '0'], ['--unknown']]) {
        assert.throws(() => parseArgs(args));
    }
});

test('observed MIX AC+ response supplies charge, charging power and both verified serials', () => {
    const reading = inspectBatteryReport(liveReport);
    assert.equal(reading.serialMatches, true);
    assert.equal(reading.batterySerialMatches, true);
    assert.equal(reading.socPercent, 86);
    assert.equal(reading.socSource, 'packData.socLevel');
    assert.equal(reading.aggregateSocPercent, 86);
    assert.equal(reading.chargingPowerW, 900);
    assert.equal(reading.dischargingPowerW, 0);
    assert.equal(reading.battery.powerW, 829);
    assert.equal(reading.state, 'charging');
});

test('pack SOC is selected by exact serial rather than array order or device average', () => {
    const reading = inspectBatteryReport({...liveReport, packData: [
        {sn: 'OTHER', socLevel: 99, state: 1, power: 900},
        {sn: batterySerial, socLevel: 0, state: 0, power: 0}
    ]});
    assert.equal(reading.socPercent, 0);
    assert.equal(reading.state, 'standby');
    assert.equal(reading.battery.powerW, 0);
    assert.equal(reading.aggregateSocPercent, 86);
});

test('flat or nested device SOC is retained with unverified or mismatched pack identity', () => {
    for (const report of [
        {electricLevel: 0, outputPackPower: 0, packInputPower: 500, packState: 2},
        {properties: {electricLevel: 0, outputPackPower: 0, packInputPower: 500, packState: 2}}
    ]) {
        const reading = inspectBatteryReport(report);
        assert.equal(reading.socPercent, 0);
        assert.equal(reading.socSource, 'electricLevel');
        assert.equal(reading.state, 'discharging');
        assert.equal(reading.serialMatches, null);
        assert.equal(reading.batterySerialMatches, null);
        assert.equal(reading.battery, null);
    }
    const mismatched = inspectBatteryReport({...liveReport, packData: [{sn: 'OTHER', socLevel: 99}]});
    assert.equal(mismatched.batterySerialMatches, false);
    assert.equal(mismatched.socPercent, 86);
    assert.equal(mismatched.battery, null);
    const nested = inspectBatteryReport({properties: {packData: [{sn: batterySerial, socLevel: 100}]}});
    assert.equal(nested.socPercent, 100);
});

test('unrelated responses and malformed measurements cannot become charge readings', () => {
    for (const report of [undefined, null, [], 'page', {properties: []}, {error: 'offline'}, {socSet: 1000}, {total_power: 1503}]) {
        assert.equal(inspectBatteryReport(report).socPercent, null);
    }
    for (const value of ['86', null, false, -1, 101, NaN, Infinity]) {
        const reading = inspectBatteryReport({properties: {electricLevel: value}, packData: [{sn: batterySerial, socLevel: value}]});
        assert.equal(reading.socPercent, null);
    }
    const invalid = inspectBatteryReport({electricLevel: 50, packState: 3, outputPackPower: '900', packInputPower: -1});
    assert.equal(invalid.state, null);
    assert.equal(invalid.chargingPowerW, null);
    assert.equal(invalid.dischargingPowerW, null);
});

test('probe rejects mismatched, unready and HTTP error reports even with an open TCP service', async () => {
    for (const response of [
        {statusCode: 200, json: {...liveReport, sn: 'OTHER'}},
        {statusCode: 200, json: {...liveReport, properties: {...liveReport.properties, dataReady: 0}}},
        {statusCode: 401, json: liveReport},
        {statusCode: 200, json: {properties: {socSet: 1000}}}
    ]) {
        const {result} = await capture(() => probeHost(parseArgs(['--ports', '80']), [], {
            probeTcp: async () => ({port: 80, open: true}),
            requestJson: async () => response
        }));
        assert.equal(result.reading, null);
        assert.equal(result.ports[0].open, true);
    }
});

test('probe redacts credentials in JSON and request errors', async () => {
    const {output} = await capture(() => probeHost(parseArgs(['--ports', '80']), ['DO_NOT_PRINT'], {
        probeTcp: async () => ({port: 80, open: true}),
        requestJson: async url => {
            if (!url.endsWith('/properties/report')) throw new Error('echo DO_NOT_PRINT');
            return {statusCode: 200, json: {...liveReport, mqtt: {password: 'DO_NOT_PRINT'}}};
        }
    }));
    assert.doesNotMatch(output, /DO_NOT_PRINT/);
    assert.match(output, /\[redacted\]/);
});

test('main recovers by the battery MAC and retries before reporting charge', async () => {
    const hosts = [];
    const {result, output} = await capture(() => main([], {
        env: {},
        probeHost: async options => {
            hosts.push(options.host);
            return {ports: [{port: 80, open: true}], reading: options.host === '192.168.0.41' ? inspectBatteryReport(liveReport) : null};
        },
        findZendureIpByMac: async options => {
            assert.equal(options.mac, '90:64:9B:10:9A:14');
            return {host: '192.168.0.41'};
        }
    }));
    assert.equal(result, 0);
    assert.deepEqual(hosts, ['192.168.0.40', '192.168.0.41']);
    assert.match(output, /Current charge level: 86%/);
});

test('main skips recovery when a reading exists, fallback is disabled or sockets are denied', async () => {
    for (const scenario of [
        {args: [], ports: [{open: true}], reading: inspectBatteryReport(liveReport)},
        {args: ['--no-mac-fallback'], ports: [{open: true}], reading: null},
        {args: [], ports: [{open: false, error: 'EPERM'}], reading: null}
    ]) {
        const {result} = await capture(() => main(scenario.args, {
            env: {},
            probeHost: async () => scenario,
            findZendureIpByMac: async () => { throw new Error('Unexpected discovery.'); }
        }));
        assert.equal(result, scenario.reading ? 0 : 1);
    }
});

test('cloud-only identity discovery does not count as a current charge reading', async () => {
    const token = Buffer.from('https://app.zendure.tech/eu.fixtureAppKey').toString('base64');
    const {result, output} = await capture(() => main(['--cloud', '--no-mac-fallback'], {
        env: {ZENDURE_KEY: token},
        probeHost: async () => ({ports: [{open: false}], reading: null}),
        lookupCloud: async (options, key) => {
            assert.equal(key, token);
            assert.equal(options.serial, serial);
            assert.equal(options.id, '492766');
            return {count: 1, matches: [{serial}]};
        }
    }));
    assert.equal(result, 1);
    assert.match(output, /does not provide a live battery charge reading/);
    await assert.rejects(main(['--cloud'], {
        env: {}, probeHost: async () => { throw new Error('Must validate credentials before requests.'); }
    }), /Set ZENDURE_KEY/);
});

test('CLI reads the observed report over HTTP and displays charge and power without writes', async t => {
    const requests = [];
    const server = http.createServer((request, response) => {
        requests.push({method: request.method, path: request.url});
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(request.url === '/properties/report' ? liveReport : {connected: false}));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    const result = await runCli(['--host', '127.0.0.1', '--ports', String(server.address().port), '--timeout', '500']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Current charge level: 86% \(packData.socLevel\)/);
    assert.match(result.stdout, /Device serial identity confirmed/);
    assert.match(result.stdout, /Battery serial confirmed: BEAAVCDLA283460/);
    assert.match(result.stdout, /Battery state: charging/);
    assert.match(result.stdout, /Battery charging power \(outputPackPower\): 900 W/);
    assert.match(result.stdout, /Battery pack power: 829 W/);
    assert.deepEqual(requests, [
        {method: 'GET', path: '/properties/report'},
        {method: 'GET', path: '/rpc?method=HA.Mqtt.GetStatus'},
        {method: 'GET', path: '/'}
    ]);
});

test('CLI help and invalid options use the documented exit codes', async () => {
    const help = await runCli(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--battery-serial/);
    const invalid = await runCli(['--timeout', '0']);
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /--timeout/);
});
