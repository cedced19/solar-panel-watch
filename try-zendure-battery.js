#!/usr/bin/env node
'use strict';

// Standalone, read-only SolarFlow probe; shares the meter's built-in-only helpers.
// Fields: https://github.com/Zendure/zenSDK/blob/main/docs/en_properties.md
const {
    parseArgs: parseProbeArgs, probeTcp, requestJson, redact,
    findZendureIpByMac, decodeCloudKey, lookupCloud
} = require('./try-zendure');

const DEFAULTS = {
    host: '192.168.0.40',
    serial: 'ANACVCDLP283458',
    id: '492766',
    mac: '90:64:9B:10:9A:14',
    batterySerial: 'BEAAVCDLA283460',
    macFallback: true,
    timeout: 3000,
    ports: [80, 443, 8000, 8080, 1883, 8883, 502],
    cloud: false
};

function parseArgs(args) {
    const probeArgs = [];
    let batterySerial = DEFAULTS.batterySerial;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--help' || args[i] === '-h') return {...DEFAULTS, help: true};
        if (args[i] === '--battery-serial') {
            batterySerial = args[++i];
            if (!batterySerial?.trim() || batterySerial.startsWith('-')) {
                throw new Error('Missing value for --battery-serial.');
            }
        } else {
            probeArgs.push(args[i]);
            // Preserve flag values, even if a serial happens to resemble a flag.
            if (['--host', '--serial', '--mac', '--id', '--timeout', '--ports'].includes(args[i])) {
                probeArgs.push(args[++i]);
            }
        }
    }
    return {...parseProbeArgs(probeArgs, DEFAULTS), batterySerial};
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonnegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function percent(value) {
    const number = nonnegative(value);
    return number !== null && number <= 100 ? number : null;
}

function stateName(value) {
    return Number.isInteger(value) ? ['standby', 'charging', 'discharging'][value] ?? null : null;
}

function inspectBatteryReport(report, options = DEFAULTS) {
    const properties = report?.properties ?? report;
    const object = isObject(properties) ? properties : {};
    const serial = report?.sn ?? report?.snNumber ?? object.sn ?? object.snNumber;
    const packs = report?.packData ?? object.packData;
    const batterySerials = Array.isArray(packs) ? packs.filter(isObject).map(pack => pack.sn).filter(sn => typeof sn === 'string') : [];
    const pack = Array.isArray(packs) ? packs.find(pack => isObject(pack) && pack.sn === options.batterySerial) : undefined;
    const battery = pack ? {
        serial: pack.sn,
        socPercent: percent(pack.socLevel),
        state: stateName(pack.state),
        powerW: nonnegative(pack.power)
    } : null;
    const aggregateSocPercent = percent(object.electricLevel);
    const packSocPercent = battery?.socPercent ?? null;
    return {
        serial,
        serialMatches: serial == null ? null : serial === options.serial,
        batterySerials,
        batterySerialMatches: battery ? true : batterySerials.length ? false : null,
        battery,
        aggregateSocPercent,
        socPercent: packSocPercent ?? aggregateSocPercent,
        socSource: packSocPercent !== null ? 'packData.socLevel' : aggregateSocPercent !== null ? 'electricLevel' : null,
        state: battery?.state ?? stateName(object.packState),
        chargingPowerW: nonnegative(object.outputPackPower),
        dischargingPowerW: nonnegative(object.packInputPower),
        dataReady: object.dataReady === 0 ? false : object.dataReady === 1 ? true : null
    };
}

async function probeHost(options, sensitiveValues = [], dependencies = {}) {
    const connect = dependencies.probeTcp || probeTcp;
    const request = dependencies.requestJson || requestJson;
    console.log(`\nTesting TCP ports at ${options.host}...`);
    const ports = await Promise.all(options.ports.map(port => connect(options.host, port, options.timeout)));
    for (const result of ports) console.log(`  ${result.port}: ${result.open ? 'OPEN' : result.error}`);
    let reading = null;
    for (const result of ports.filter(result => result.open && ![1883, 8883, 502].includes(result.port))) {
        const base = `${result.port === 443 ? 'https' : 'http'}://${options.host}:${result.port}`;
        for (const path of ['/properties/report', '/rpc?method=HA.Mqtt.GetStatus', '/']) {
            const url = `${base}${path}`;
            try {
                const response = await request(url, options.timeout);
                console.log(`\nGET ${url}: HTTP ${response.statusCode}`);
                if (response.json !== undefined) {
                    console.log(JSON.stringify(redact(response.json, sensitiveValues), null, 2));
                } else {
                    console.log(`  Non-JSON response (${response.length} bytes).`);
                }
                if (path !== '/properties/report' || response.statusCode !== 200) continue;
                const report = inspectBatteryReport(response.json, options);
                if (report.serialMatches === false) {
                    console.log(`  Serial mismatch: received ${report.serial}; expected ${options.serial}.`);
                } else if (report.dataReady === false) {
                    console.log('  Device reports dataReady=0; charge reading is not ready.');
                } else if (report.socPercent !== null) {
                    if (!reading || (report.serialMatches === true && reading.serialMatches !== true)) reading = report;
                } else {
                    console.log('  No valid charge percentage in this response.');
                }
            } catch (error) {
                console.log(`\nGET ${url}: ${redact(error.code || error.message, sensitiveValues)}`);
            }
        }
    }
    return {ports, reading};
}

function printReading(reading, options) {
    console.log(`\nCurrent charge level: ${reading.socPercent}% (${reading.socSource}).`);
    console.log(`Device serial identity ${reading.serialMatches === true ? 'confirmed' : 'not verified by the response'}.`);
    if (reading.aggregateSocPercent !== null) {
        console.log(`Device average charge (electricLevel): ${reading.aggregateSocPercent}%.`);
    }
    if (reading.battery) {
        console.log(`Battery serial confirmed: ${reading.battery.serial}.`);
        if (reading.battery.socPercent !== null) console.log(`Battery charge (socLevel): ${reading.battery.socPercent}%.`);
        if (reading.battery.powerW !== null) console.log(`Battery pack power: ${reading.battery.powerW} W.`);
    } else if (reading.batterySerialMatches === false) {
        console.log(`No pack matches ${options.batterySerial}; received: ${reading.batterySerials.join(', ')}. Charge is the device average.`);
    } else {
        console.log('Battery serial identity not verified by the response. Charge is the device average.');
    }
    if (reading.state !== null) console.log(`Battery state: ${reading.state}.`);
    if (reading.chargingPowerW !== null) console.log(`Battery charging power (outputPackPower): ${reading.chargingPowerW} W.`);
    if (reading.dischargingPowerW !== null) console.log(`Battery discharging power (packInputPower): ${reading.dischargingPowerW} W.`);
}

async function main(args = process.argv.slice(2), dependencies = {}) {
    const options = parseArgs(args);
    if (options.help) {
        console.log(`Usage: node try-zendure-battery.js [options]

  --host IP               Battery device IPv4 address (default: ${DEFAULTS.host})
  --serial SERIAL         Expected device serial (default: ${DEFAULTS.serial})
  --battery-serial SERIAL Expected pack serial (default: ${DEFAULTS.batterySerial})
  --mac MAC               Fallback MAC address (default: ${DEFAULTS.mac})
  --no-mac-fallback       Disable MAC discovery if no charge reading is received
  --id ID                 Expected cloud identity (default: ${DEFAULTS.id})
  --timeout MS            Deadline per request (default: ${DEFAULTS.timeout})
  --ports LIST            TCP ports (default: ${DEFAULTS.ports.join(',')})
  --cloud                 Also list matching devices using ZENDURE_KEY
  --help                  Show this help

Reads charge percentage, charging/discharging power and pack status.
Only status is read; no settings or charging commands are sent.
MAC recovery uses the configured host's /24 subnet and an exact MAC match.
Cloud mode lists devices; it does not supply live battery readings.
Exit codes: 0 = a usable LAN charge reading; 1 = no charge reading;
            2 = invalid options or failed optional cloud lookup.`);
        return 0;
    }
    const token = (dependencies.env || process.env).ZENDURE_KEY?.trim();
    if (options.cloud) decodeCloudKey(token);
    const sensitiveValues = [token];
    try { sensitiveValues.push(decodeCloudKey(token).appKey); } catch { /* Cloud is optional. */ }
    console.log(`Zendure SolarFlow 3000 MIX AC+: ${options.host}\nExpected serial: ${options.serial}; identity: ${options.id}; fallback MAC: ${options.mac}\nExpected built-in battery serial: ${options.batterySerial}`);
    const probe = dependencies.probeHost || probeHost;
    let result = await probe(options, sensitiveValues);
    if (!result.reading && options.macFallback && !result.ports.some(port => ['EPERM', 'EACCES'].includes(port.error))) {
        console.log(`\nTrying MAC fallback for ${options.mac} in ${options.host.split('.').slice(0, 3).join('.')}.0/24...`);
        const recovered = await (dependencies.findZendureIpByMac || findZendureIpByMac)(options);
        if (recovered.host) {
            console.log(`MAC ${options.mac} found at ${recovered.host}; retrying the battery probe.`);
            options.host = recovered.host;
            result = await probe(options, sensitiveValues);
        } else {
            console.log(recovered.unavailable ? 'MAC discovery unavailable: cannot read the neighbor table or open LAN sockets.' :
                'No other IP found for this MAC in the configured /24 subnet.');
        }
    }
    console.log(`\nLAN result: ${result.ports.some(port => port.open) ? 'at least one TCP service is reachable' : 'no tested TCP service could be opened'}.`);
    if (result.reading) {
        printReading(result.reading, options);
    } else {
        console.log('No usable battery charge reading received.');
        console.log('Check the IP, LAN routing, and local API/HEMS setting in the Zendure app.');
    }
    if (result.ports.some(port => ['EPERM', 'EACCES'].includes(port.error))) {
        console.log('Socket access was denied by this execution environment. Run on a computer on the battery LAN.');
    }
    if (options.cloud) {
        console.log('\nLooking up the battery device through Zendure cloud...');
        const cloud = await (dependencies.lookupCloud || lookupCloud)(options, token);
        console.log(`Cloud returned ${cloud.count} device(s); ${cloud.matches.length} match(es).`);
        console.log(JSON.stringify(redact(cloud.matches, sensitiveValues), null, 2));
        console.log('Cloud device discovery does not provide a live battery charge reading.');
    }
    return result.reading ? 0 : 1;
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        const token = process.env.ZENDURE_KEY?.trim();
        let appKey;
        try { appKey = decodeCloudKey(token).appKey; } catch { /* Invalid keys are not echoed. */ }
        console.error(`Error: ${redact(error.code || error.message, [token, appKey])}`);
        process.exitCode = 2;
    });
}

module.exports = {parseArgs, inspectBatteryReport, probeHost, main};
