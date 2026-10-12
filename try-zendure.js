#!/usr/bin/env node
'use strict';

// Standalone, read-only probe; uses only Node.js built-ins.
// LAN API: https://github.com/Zendure/zenSDK
// Cloud signing: https://github.com/Zendure/Zendure-HA/blob/master/custom_components/zendure_ha/api.py
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const {createHash, randomInt} = require('node:crypto');

const DEFAULTS = {
    host: '192.168.0.48',
    serial: 'TEE1NJP7P341978',E0:72:A1:85:24:48
    id: '492848',
    timeout: 3000,
    ports: [80, 443, 8000, 8080, 1883, 8883, 502],
    cloud: false
};

function parseArgs(args) {
    const options = {...DEFAULTS};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--help' || arg === '-h') return {...options, help: true};
        if (arg === '--cloud') {
            options.cloud = true;
            continue;
        }
        if (!['--host', '--serial', '--id', '--timeout', '--ports'].includes(arg)) {
            throw new Error(`Unknown option: ${arg}. Use --help.`);
        }
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
        options[arg.slice(2)] = value;
    }
    if (net.isIP(options.host) !== 4) throw new Error('--host must be an IPv4 address.');
    options.timeout = Number(options.timeout);
    if (!Number.isInteger(options.timeout) || options.timeout < 1 || options.timeout > 60000) {
        throw new Error('--timeout must be between 1 and 60000 milliseconds.');
    }
    if (typeof options.ports === 'string') options.ports = options.ports.split(',').map(Number);
    if (!options.ports.length || options.ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new Error('--ports must be comma-separated TCP ports between 1 and 65535.');
    }
    options.ports = [...new Set(options.ports)];
    return options;
}

function probeTcp(host, port, timeout) {
    return new Promise(resolve => {
        const socket = net.createConnection({host, port});
        const timer = setTimeout(() => finish('ETIMEDOUT'), timeout);
        function finish(error) {
            clearTimeout(timer);
            socket.destroy();
            resolve({port, open: !error, error});
        }
        socket.once('connect', () => finish());
        socket.once('error', error => finish(error.code || 'CONNECTION_ERROR'));
    });
}

function requestJson(url, timeout, options = {}) {
    return new Promise((resolve, reject) => {
        const transport = new URL(url).protocol === 'https:' ? https : http;
        const request = transport.request(url, {
            method: options.method || 'GET',
            headers: {Accept: 'application/json', ...options.headers},
            agent: false
        }, response => {
            const chunks = [];
            let length = 0;
            response.on('data', chunk => {
                length += chunk.length;
                if (length > 65536) {
                    request.destroy(new Error('Response exceeds 64 KiB.'));
                    return;
                }
                chunks.push(chunk);
            });
            response.once('error', fail);
            response.once('end', () => {
                clearTimeout(timer);
                const body = Buffer.concat(chunks).toString('utf8');
                let json;
                try { json = JSON.parse(body); } catch { /* A web page is still a response. */ }
                resolve({statusCode: response.statusCode, json, length});
            });
        });
        const timer = setTimeout(() => request.destroy(Object.assign(new Error('Request timed out.'), {code: 'ETIMEDOUT'})), timeout);
        function fail(error) {
            clearTimeout(timer);
            reject(error);
        }
        request.once('error', fail);
        request.end(options.body);
    });
}

function redact(value, sensitiveValues = []) {
    if (Array.isArray(value)) return value.map(item => redact(item, sensitiveValues));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            /password|passwd|token|secret|authorization|appkey|apikey/i.test(key) ? '[redacted]' : redact(item, sensitiveValues)
        ]));
    }
    if (typeof value === 'string') {
        for (const secret of sensitiveValues.filter(Boolean)) value = value.split(secret).join('[redacted]');
    }
    return value;
}

function inspectReport(report, expectedSerial) {
    const properties = report?.properties ?? report;
    const object = properties && typeof properties === 'object' && !Array.isArray(properties);
    // The observed 1CT-S response is flat, unlike the nested zenSDK examples.
    const power = object ? Object.fromEntries(Object.entries(properties).filter(([key, value]) =>
        ['total_power', 'a_aprt_power', 'b_aprt_power', 'c_aprt_power'].includes(key) && typeof value === 'number'
    )) : {};
    const isReport = Boolean(object && (report?.properties === properties || Object.keys(power).length));
    const serial = report?.sn ?? report?.snNumber ?? properties?.sn ?? properties?.snNumber;
    return {isReport, serial, serialMatches: serial == null ? null : serial === expectedSerial, power};
}

function decodeCloudKey(token) {
    if (!token || !/^[A-Za-z0-9+/]+={0,2}$/.test(token)) {
        throw new Error('Set ZENDURE_KEY to the base64 authorization key from the Zendure app.');
    }
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const separator = decoded.lastIndexOf('.');
    if (separator < 0 || separator === decoded.length - 1) throw new Error('Invalid ZENDURE_KEY format.');
    let url;
    try { url = new URL(decoded.slice(0, separator)); } catch { throw new Error('Invalid ZENDURE_KEY URL.'); }
    // Only send this credential to the documented Zendure HTTPS API.
    if (url.origin !== 'https://app.zendure.tech' || !['/eu', '/v2'].includes(url.pathname) || url.search || url.hash || url.username || url.password) {
        throw new Error('ZENDURE_KEY must reference https://app.zendure.tech/eu or /v2.');
    }
    return {apiUrl: url.href.replace(/\/$/, ''), appKey: decoded.slice(separator + 1)};
}

function cloudRequest(token, timestamp = Math.floor(Date.now() / 1000), nonce = String(randomInt(10000, 100000))) {
    const {apiUrl, appKey} = decodeCloudKey(token);
    // Public protocol constant from Zendure-HA/const.py, not the user's credential.
    const signingKey = 'C*dafwArEOXK';
    const sign = createHash('sha1').update(`${signingKey}appKey${appKey}nonce${nonce}timestamp${timestamp}${signingKey}`).digest('hex').toUpperCase();
    return {
        url: `${apiUrl}/api/ha/deviceList`,
        method: 'POST',
        headers: {'Content-Type': 'application/json', timestamp: String(timestamp), nonce, clientid: 'zenHa', sign},
        body: JSON.stringify({appKey})
    };
}

async function lookupCloud(options, token, requestFn = requestJson) {
    const request = cloudRequest(token);
    const response = await requestFn(request.url, options.timeout, request);
    const result = response.json;
    if (response.statusCode !== 200 || result?.code !== 200 || result?.success !== true) {
        throw new Error(`Zendure cloud lookup failed (HTTP ${response.statusCode}, API code ${result?.code ?? 'unknown'}).`);
    }
    const devices = result.data?.deviceList;
    if (!Array.isArray(devices)) throw new Error('Zendure cloud returned no device list.');
    const matches = devices.filter(device =>
        device.snNumber === options.serial || device.sn === options.serial ||
        [device.deviceId, device.id, device.deviceKey].some(id => id != null && String(id) === options.id)
    );
    // Never print the MQTT credentials returned alongside the device list.
    return {
        count: devices.length,
        matches: matches.map(device => ({
            serial: device.snNumber ?? device.sn,
            id: device.deviceId ?? device.id,
            name: device.deviceName,
            model: device.productModel
        }))
    };
}

async function main(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    if (options.help) {
        console.log(`Usage: node try-zendure.js [options]

  --host IP         Meter IPv4 address (default: ${DEFAULTS.host})
  --serial SERIAL   Expected serial (default: ${DEFAULTS.serial})
  --id ID           Expected cloud identity (default: ${DEFAULTS.id})
  --timeout MS      Deadline per connection/request (default: ${DEFAULTS.timeout})
  --ports LIST      TCP ports (default: ${DEFAULTS.ports.join(',')})
  --cloud           Also look up the meter using the ZENDURE_KEY environment variable
  --help            Show this help

Local requests only read status. --cloud lists devices; it sends no control commands.
Exit codes: 0 = a tested LAN TCP port opened; 1 = none opened;
            2 = invalid options or failed cloud lookup.
A cloud result does not establish LAN reachability or provide live meter readings.`);
        return 0;
    }
    const token = process.env.ZENDURE_KEY?.trim();
    // Validate before sending any requests if cloud mode was explicitly requested.
    if (options.cloud) decodeCloudKey(token);
    const sensitiveValues = token ? [token, decodeCloudKeySafe(token)] : [];
    console.log(`Zendure Smart Meter 1CT-S: ${options.host}\nExpected serial: ${options.serial}; identity: ${options.id}`);
    console.log('\nTesting TCP ports...');
    const ports = await Promise.all(options.ports.map(port => probeTcp(options.host, port, options.timeout)));
    for (const result of ports) console.log(`  ${result.port}: ${result.open ? 'OPEN' : result.error}`);
    let reportFound = false;
    let serialConfirmed = false;
    for (const result of ports.filter(result => result.open && ![1883, 8883, 502].includes(result.port))) {
        const protocol = result.port === 443 ? 'https' : 'http';
        const base = `${protocol}://${options.host}:${result.port}`;
        // Sequential requests avoid overwhelming the embedded HTTP server.
        for (const path of ['/properties/report', '/rpc?method=HA.Mqtt.GetStatus', '/']) {
            const url = `${base}${path}`;
            try {
                const response = await requestJson(url, options.timeout);
                console.log(`\nGET ${url}: HTTP ${response.statusCode}`);
                if (response.json !== undefined) {
                    console.log(JSON.stringify(redact(response.json, sensitiveValues), null, 2));
                } else {
                    console.log(`  Non-JSON response (${response.length} bytes).`);
                }
                if (path === '/properties/report' && response.statusCode === 200) {
                    const report = inspectReport(response.json, options.serial);
                    if (report.isReport) {
                        if (report.serialMatches === false) {
                            console.log(`  Serial mismatch: received ${report.serial}; expected ${options.serial}.`);
                        } else {
                            reportFound = true;
                            serialConfirmed ||= report.serialMatches === true;
                            console.log(report.serialMatches ? '  Meter serial matches.' : '  Meter report received; no serial returned to verify identity.');
                            if (Object.keys(report.power).length) {
                                console.log(`  Power fields (raw device values): ${JSON.stringify(report.power)}`);
                            }
                        }
                    }
                }
            } catch (error) {
                console.log(`\nGET ${url}: ${error.code || error.message}`);
            }
        }
    }
    const reachable = ports.some(result => result.open);
    console.log(`\nLAN result: ${reachable ? 'at least one TCP service is reachable' : 'no tested TCP service could be opened'}.`);
    if (reportFound) {
        console.log(`Local meter report received. Serial identity ${serialConfirmed ? 'confirmed' : 'not verified by the response'}.`);
    } else {
        console.log('No report from the expected meter received. This does not prove the meter is offline.');
        console.log('Check the IP, LAN routing, and local API/HEMS setting in the Zendure app.');
        console.log('The zenSDK support list names SmartMeter3CT; 1CT-S support is unconfirmed.');
    }
    if (ports.some(result => ['EPERM', 'EACCES'].includes(result.error))) {
        console.log('Socket access was denied by this execution environment. Run on a computer on the meter LAN.');
    }
    if (options.cloud) {
        console.log('\nLooking up the meter through Zendure cloud...');
        const cloud = await lookupCloud(options, token);
        console.log(`Cloud returned ${cloud.count} device(s); ${cloud.matches.length} match(es).`);
        console.log(JSON.stringify(redact(cloud.matches, sensitiveValues), null, 2));
        if (!cloud.matches.length) console.log('This cloud API may not expose the smart meter, even if it appears in the Zendure app.');
    }
    return reachable ? 0 : 1;
}

function decodeCloudKeySafe(token) {
    try { return decodeCloudKey(token).appKey; } catch { return undefined; }
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(`Error: ${redact(error.code || error.message, [process.env.ZENDURE_KEY, decodeCloudKeySafe(process.env.ZENDURE_KEY)])}`);
        process.exitCode = 2;
    });
}

module.exports = {parseArgs, probeTcp, requestJson, redact, inspectReport, decodeCloudKey, cloudRequest, lookupCloud, main};
