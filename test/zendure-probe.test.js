'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {spawn} = require('node:child_process');
const path = require('node:path');
const {once} = require('node:events');
const {parseArgs, normalizeMac, findIpInNeighbors, findZendureIpByMac, main, probeTcp, requestJson, redact, inspectReport, decodeCloudKey, cloudRequest, lookupCloud} = require('../try-zendure');

const serial = 'TEE1NJP7P341978';
const mac = 'E0:72:A1:85:24:48';
const token = Buffer.from('https://app.zendure.tech/eu.fixtureAppKey').toString('base64');
// Shape observed from the actual 1CT-S, including a zero-valued phase.
const flatReport = {timestamp: 1791828793, messageId: 133, deviceId: 'fixtureDevice', a_aprt_power: 0, b_aprt_power: 0, c_aprt_power: 1503, total_power: 1503};

async function fixture(t, handler) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    const port = server.address().port;
    return {port, url: `http://127.0.0.1:${port}`};
}

async function runCli(args) {
    const child = spawn(process.execPath, [path.join(__dirname, '../try-zendure.js'), '--no-mac-fallback', ...args], {
        env: {...process.env, ZENDURE_KEY: ''}
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    return {code, stdout, stderr};
}

test('options reject missing values, invalid addresses, deadlines and ports', () => {
    assert.deepEqual(parseArgs(['--ports', '80,80,8080']).ports, [80, 8080]);
    assert.equal(parseArgs([]).mac, mac);
    assert.equal(parseArgs([]).macFallback, true);
    assert.equal(parseArgs(['--no-mac-fallback']).macFallback, false);
    assert.equal(parseArgs(['--mac', 'e0-72-a1-85-24-48']).mac, mac);
    for (const args of [['--host'], ['--host', 'example.com'], ['--mac'], ['--mac', 'E0:72:A1'], ['--timeout', '0'], ['--timeout', 'Infinity'], ['--ports', '80,'], ['--ports', '65536'], ['--unknown']]) {
        assert.throws(() => parseArgs(args));
    }
});

test('MAC normalization accepts common formats and rejects malformed addresses', () => {
    for (const address of [mac, 'e0:72:a1:85:24:48', 'e0-72-a1-85-24-48', 'e072a1852448']) {
        assert.equal(normalizeMac(address), mac);
    }
    for (const address of ['', 'garbage E0:72:A1:85:24:48', 'E0:72:A1:85:24', 'ZZ:72:A1:85:24:48']) {
        assert.equal(normalizeMac(address), null);
    }
});

test('neighbor parsing matches the exact MAC across Linux, macOS and Windows formats', () => {
    for (const table of [
        '192.168.0.37 dev eth0 lladdr e0:72:a1:85:24:48 REACHABLE',
        '192.168.0.37 0x1 0x2 e0:72:a1:85:24:48 * eth0',
        '? (192.168.0.37) at e0:72:a1:85:24:48 on en0 ifscope [ethernet]',
        '  192.168.0.37     e0-72-a1-85-24-48    dynamic'
    ]) {
        assert.equal(findIpInNeighbors(table, mac, '192.168.0.48'), '192.168.0.37');
    }
    for (const table of [
        '192.168.0.37 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE',
        '192.168.0.37 dev eth0 lladdr e0:72:a1:85:24:48 FAILED',
        '192.168.0.37 dev eth0 lladdr e0:72:a1:85:24:48 INCOMPLETE',
        '192.168.1.37 dev eth0 lladdr e0:72:a1:85:24:48 REACHABLE',
        '192.168.0.48 dev eth0 lladdr e0:72:a1:85:24:48 REACHABLE',
        '192.168.0.255 dev eth0 lladdr e0:72:a1:85:24:48 REACHABLE'
    ]) {
        assert.equal(findIpInNeighbors(table, mac, '192.168.0.48'), null);
    }
});

test('MAC recovery uses a cached match without scanning the subnet', async () => {
    const result = await findZendureIpByMac(parseArgs([]), {
        readNeighbors: async () => '192.168.0.37 dev eth0 lladdr e0:72:a1:85:24:48 STALE',
        probeTcp: async () => { throw new Error('Unexpected subnet scan.'); }
    });
    assert.deepEqual(result, {host: '192.168.0.37'});
});

test('MAC recovery populates neighbors with bounded probes and stops at an exact match', async () => {
    const calls = [];
    let table = '';
    let active = 0;
    let maximum = 0;
    const result = await findZendureIpByMac(parseArgs([]), {
        readNeighbors: async () => table,
        probeTcp: async (host, port, timeout) => {
            calls.push({host, port, timeout});
            maximum = Math.max(maximum, ++active);
            await Promise.resolve();
            if (host === '192.168.0.37') table = `${host} dev eth0 lladdr e0:72:a1:85:24:48 REACHABLE`;
            active--;
            return {port, open: false, error: 'ECONNREFUSED'};
        }
    });
    assert.equal(result.host, '192.168.0.37');
    assert.equal(maximum, 16);
    assert.equal(calls.length, 48);
    assert.ok(calls.every(call => call.host.startsWith('192.168.0.') && call.host !== '192.168.0.48' && call.port === 80 && call.timeout <= 250));
});

test('MAC recovery does not select responding hosts without a matching MAC', async () => {
    let count = 0;
    const result = await findZendureIpByMac(parseArgs([]), {
        readNeighbors: async () => '192.168.0.37 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE',
        probeTcp: async () => { count++; return {open: true}; }
    });
    assert.deepEqual(result, {host: null});
    assert.equal(count, 253);
});

test('MAC recovery reports unavailable tables or denied sockets', async () => {
    assert.deepEqual(await findZendureIpByMac(parseArgs([]), {
        readNeighbors: async () => null,
        probeTcp: async () => { throw new Error('Unexpected subnet scan.'); }
    }), {host: null, unavailable: true});
    let count = 0;
    assert.deepEqual(await findZendureIpByMac(parseArgs([]), {
        readNeighbors: async () => '',
        probeTcp: async () => { count++; return {open: false, error: 'EPERM'}; }
    }), {host: null, unavailable: true});
    assert.equal(count, 16);
});

async function captureMain(args, dependencies) {
    const lines = [];
    const original = console.log;
    console.log = line => lines.push(line);
    try { return {code: await main(args, dependencies), output: lines.join('\n')}; }
    finally { console.log = original; }
}

test('main retries the recovered address when the configured IP has no meter report', async () => {
    const hosts = [];
    const result = await captureMain([], {
        probeHost: async options => {
            hosts.push(options.host);
            return {ports: [{port: 80, open: true}], reportFound: options.host === '192.168.0.37', serialConfirmed: false};
        },
        findZendureIpByMac: async options => {
            assert.equal(options.mac, mac);
            return {host: '192.168.0.37'};
        }
    });
    assert.equal(result.code, 0);
    assert.deepEqual(hosts, ['192.168.0.48', '192.168.0.37']);
    assert.match(result.output, /MAC E0:72:A1:85:24:48 found at 192.168.0.37/);
    assert.match(result.output, /Local meter report received/);
});

test('main skips discovery for a valid report, disabled fallback or denied sockets', async () => {
    for (const scenario of [
        {args: [], reportFound: true, ports: [{open: true}]},
        {args: ['--no-mac-fallback'], reportFound: false, ports: [{open: false}]},
        {args: [], reportFound: false, ports: [{open: false, error: 'EPERM'}]}
    ]) {
        const result = await captureMain(scenario.args, {
            probeHost: async () => ({...scenario, serialConfirmed: false}),
            findZendureIpByMac: async () => { throw new Error('Unexpected MAC recovery.'); }
        });
        assert.equal(result.code, scenario.reportFound ? 0 : 1);
    }
});

test('main reports a failed MAC lookup and keeps its LAN failure exit code', async () => {
    const result = await captureMain([], {
        probeHost: async () => ({ports: [{open: false}], reportFound: false, serialConfirmed: false}),
        findZendureIpByMac: async () => ({host: null})
    });
    assert.equal(result.code, 1);
    assert.match(result.output, /No other IP found for this MAC/);
});

test('flat 1CT-S report preserves zero and does not claim a serial match', () => {
    const report = inspectReport(flatReport, serial);
    assert.equal(report.isReport, true);
    assert.equal(report.serialMatches, null);
    assert.equal(report.power.total_power, 1503);
    assert.equal(report.power.a_aprt_power, 0);
    for (const value of [undefined, [], 'page', {error: 'offline'}, {total_power: '1503'}, {properties: []}]) {
        assert.equal(inspectReport(value, serial).isReport, false);
    }
});

test('nested zenSDK reports confirm identity only when the serial matches', () => {
    assert.equal(inspectReport({sn: serial, properties: {power: 10}}, serial).serialMatches, true);
    assert.equal(inspectReport({sn: 'OTHER', properties: {power: 10}}, serial).serialMatches, false);
});

test('cloud key decoding allows only the Zendure HTTPS API', () => {
    assert.deepEqual(decodeCloudKey(token), {apiUrl: 'https://app.zendure.tech/eu', appKey: 'fixtureAppKey'});
    for (const value of ['', 'invalid!', 'https://evil.example/eu.fixtureAppKey', 'http://app.zendure.tech/eu.fixtureAppKey', 'https://app.zendure.tech.evil.example/eu.fixtureAppKey', 'https://user:pass@app.zendure.tech/eu.fixtureAppKey']) {
        assert.throws(() => decodeCloudKey(value.includes('://') ? Buffer.from(value).toString('base64') : value));
    }
    const request = cloudRequest(token, 1700000000, '12345');
    assert.equal(request.url, 'https://app.zendure.tech/eu/api/ha/deviceList');
    assert.equal(request.headers.sign, '762C62C4622D0D9E256B9E91CD3E1A07C0B2ABCA');
});

test('redaction removes nested credentials and literal credential echoes', () => {
    const result = redact({password: 'hidden', mqtt: [{secret: 'hidden', text: 'echo fixtureAppKey'}], total_power: 0}, ['fixtureAppKey']);
    assert.equal(result.password, '[redacted]');
    assert.equal(result.mqtt[0].secret, '[redacted]');
    assert.equal(result.mqtt[0].text, 'echo [redacted]');
    assert.equal(result.total_power, 0);
});

test('cloud matching handles serial and numeric identity without returning MQTT credentials', async () => {
    const result = await lookupCloud({serial, id: '492848', timeout: 500}, token, async () => ({
        statusCode: 200,
        json: {code: 200, success: true, data: {
            mqtt: {password: 'DO_NOT_PRINT'},
            deviceList: [{snNumber: serial, deviceName: 'Meter', productModel: '1CT-S', password: 'DO_NOT_PRINT'}, {deviceId: 492848}, {snNumber: 'OTHER'}]
        }}
    }));
    assert.equal(result.count, 3);
    assert.equal(result.matches.length, 2);
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_PRINT|mqtt|password/);
    await assert.rejects(lookupCloud({timeout: 500}, token, async () => ({statusCode: 401, json: {msg: 'DO_NOT_PRINT'}})), /HTTP 401/);
});

test('TCP probe reports open and refused ports', async t => {
    const {port} = await fixture(t, (_request, response) => response.end());
    assert.equal((await probeTcp('127.0.0.1', port, 500)).open, true);
    const closed = http.createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const closedPort = closed.address().port;
    await new Promise(resolve => closed.close(resolve));
    assert.equal((await probeTcp('127.0.0.1', closedPort, 500)).error, 'ECONNREFUSED');
});

test('HTTP preserves auth errors and non-JSON responses as network responses', async t => {
    const {url} = await fixture(t, (_request, response) => {
        response.writeHead(401, {'Content-Type': 'text/html'});
        response.end('<html>Authentication required</html>');
    });
    const result = await requestJson(url, 500);
    assert.equal(result.statusCode, 401);
    assert.equal(result.json, undefined);
    assert.ok(result.length > 0);
});

test('HTTP has a total deadline even when the server keeps sending data', async t => {
    const {url} = await fixture(t, (_request, response) => {
        response.writeHead(200);
        response.write('{');
        const interval = setInterval(() => response.write(' '), 10);
        response.once('close', () => clearInterval(interval));
    });
    await assert.rejects(requestJson(url, 80), {code: 'ETIMEDOUT'});
});

test('HTTP stops reading oversized responses', async t => {
    const {url} = await fixture(t, (_request, response) => response.end('x'.repeat(70000)));
    await assert.rejects(requestJson(url, 500), /exceeds 64 KiB/);
});

test('CLI reads the flat report without writes and reports identity separately', async t => {
    const paths = [];
    const {port} = await fixture(t, (request, response) => {
        paths.push({method: request.method, path: request.url});
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(request.url === '/properties/report' ? flatReport : {connected: false}));
    });
    const result = await runCli(['--host', '127.0.0.1', '--ports', String(port), '--timeout', '500']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"total_power": 1503/);
    assert.match(result.stdout, /Serial identity not verified/);
    assert.doesNotMatch(result.stdout, /No report from the expected meter/);
    assert.deepEqual(paths.map(request => request.method), ['GET', 'GET', 'GET']);
});

test('CLI handles serial mismatch and invalid input', async t => {
    const {port} = await fixture(t, (_request, response) => response.end(JSON.stringify({sn: 'OTHER', properties: {power: 10}})));
    const mismatch = await runCli(['--host', '127.0.0.1', '--ports', String(port), '--timeout', '500']);
    assert.equal(mismatch.code, 0); // Exit status measures TCP reachability, not identity.
    assert.match(mismatch.stdout, /Serial mismatch/);
    assert.doesNotMatch(mismatch.stdout, /Local meter report received\./);
    const invalid = await runCli(['--timeout', '0']);
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /--timeout/);
});
