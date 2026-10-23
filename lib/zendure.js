'use strict';

const http = require('node:http');
const net = require('node:net');
const {findZendureIpByMac, normalizeMacAddress} = require('./zendure-recovery');
const {parseBatterySettings} = require('./zendure-settings');

const RECOVERY_RETRY_DELAY = 60000;
const MAX_RESPONSE_BYTES = 65536;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonnegative(value) {
    const number = finiteNumber(value);
    return number !== null && number >= 0 ? number : null;
}

function percent(value) {
    const number = nonnegative(value);
    return number !== null && number <= 100 ? number : null;
}

function stateName(value) {
    return Number.isInteger(value) ? ['standby', 'charging', 'discharging'][value] ?? null : null;
}

function reportProperties(report, options = {}) {
    if (!isObject(report) || (report.properties !== undefined && !isObject(report.properties))) {
        throw new Error('Zendure returned an invalid properties report.');
    }
    const properties = report.properties ?? report;
    const serial = report.sn ?? report.snNumber ?? properties.sn ?? properties.snNumber;
    if (options.serial && serial != null && serial !== options.serial) {
        throw new Error(`Zendure serial mismatch: expected ${options.serial}.`);
    }
    if (properties.dataReady !== undefined && properties.dataReady !== 1) {
        throw new Error('Zendure reports that its data is not ready.');
    }
    return {properties, serial: serial ?? null, serialMatches: serial == null || !options.serial ? null : true};
}

function validatePowerReport(report, options = {}) {
    const {properties, serial, serialMatches} = reportProperties(report, options);
    const powerField = options.powerField ?? 'total_power';
    const powerScale = options.powerScale ?? 1;
    if (!Number.isFinite(powerScale) || powerScale === 0) throw new Error('Zendure powerScale must be a finite, nonzero number.');
    const rawPower = finiteNumber(properties[powerField]);
    const power = rawPower === null ? null : finiteNumber(rawPower * powerScale);
    if (power === null) throw new Error(`Zendure report has no valid ${powerField} power reading.`);
    return {power, serial, serialMatches};
}

// Official SolarFlow property definitions: https://github.com/Zendure/zenSDK/blob/main/docs/en_properties.md
function validateBatteryReport(report, options = {}) {
    const {properties, serial, serialMatches} = reportProperties(report, options);
    const packs = report.packData ?? properties.packData;
    const batterySerials = Array.isArray(packs) ? packs.filter(isObject).map(pack => pack.sn).filter(sn => typeof sn === 'string') : [];
    const pack = options.batterySerial && Array.isArray(packs) ?
        packs.find(pack => isObject(pack) && pack.sn === options.batterySerial) : null;
    const battery = pack ? {
        serial: pack.sn,
        socPercent: percent(pack.socLevel),
        state: stateName(pack.state),
        powerW: nonnegative(pack.power)
    } : null;
    const aggregateSocPercent = percent(properties.electricLevel);
    const packSocPercent = battery?.socPercent ?? null;
    const socPercent = packSocPercent ?? aggregateSocPercent;
    if (socPercent === null) throw new Error('Zendure report has no valid battery charge percentage.');
    return {
        serial,
        serialMatches,
        battery,
        batterySerials,
        batterySerialMatches: battery ? true : options.batterySerial && batterySerials.length ? false : null,
        aggregateSocPercent,
        socPercent,
        socSource: packSocPercent !== null ? 'packData.socLevel' : 'electricLevel',
        state: battery?.state ?? stateName(properties.packState),
        outputHomePowerW: nonnegative(properties.outputHomePower),
        gridInputPowerW: nonnegative(properties.gridInputPower),
        chargingPowerW: nonnegative(properties.outputPackPower),
        dischargingPowerW: nonnegative(properties.packInputPower)
    };
}

function requestJson(url, timeout) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const request = http.get(url, {headers: {Accept: 'application/json'}, agent: false}, response => {
            const chunks = [];
            let length = 0;
            response.on('data', chunk => {
                length += chunk.length;
                if (length > MAX_RESPONSE_BYTES) {
                    request.destroy(new Error('Zendure response exceeds 64 KiB.'));
                    return;
                }
                chunks.push(chunk);
            });
            response.once('error', fail);
            response.once('aborted', () => fail(new Error('Zendure response was interrupted.')));
            response.once('end', () => {
                if (settled) return;
                let json;
                try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
                    fail(new Error('Zendure returned invalid JSON.'));
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolve({statusCode: response.statusCode, json});
            });
        });
        const timer = setTimeout(() => request.destroy(Object.assign(new Error('Zendure request timed out.'), {code: 'ETIMEDOUT'})), timeout);
        function fail(error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        }
        request.once('error', fail);
    });
}

function positiveMilliseconds(value, fallback, name, allowZero = false) {
    const number = value ?? fallback;
    if (!Number.isFinite(number) || number < (allowZero ? 0 : 1)) throw new Error(`Zendure ${name} must be a valid millisecond interval.`);
    return number;
}

/**
 * Read-only LAN client. requestFn(url, timeout) resolves {statusCode, json}.
 * Poll results, including errors, are cached for requestThreshold milliseconds
 * from request start; response latency does not postpone scheduled polling.
 * Multiple readers share one report request; receipt time is Unix seconds.
 * Use separate clients for devices requiring independent polling intervals.
 */
function createZendureClient(options = {}) {
    if (typeof options.host !== 'string' || !options.host.trim() || /[\s/@?#]/.test(options.host)) {
        throw new Error('Zendure host must be an IP address or host name, optionally with a port.');
    }
    let origin;
    try { origin = new URL(`http://${options.host}`); } catch { throw new Error('Zendure host is invalid.'); }
    if (options.port !== undefined) {
        if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Zendure port must be between 1 and 65535.');
        origin.port = String(options.port);
    }
    for (const name of ['serial', 'batterySerial', 'powerField']) {
        if (options[name] !== undefined && (typeof options[name] !== 'string' || !options[name].trim())) {
            throw new Error(`Zendure ${name} must be a nonempty string.`);
        }
    }
    const powerScale = options.powerScale ?? 1;
    if (!Number.isFinite(powerScale) || powerScale === 0) throw new Error('Zendure powerScale must be a finite, nonzero number.');
    const timeout = positiveMilliseconds(options.timeout, 3000, 'timeout');
    const requestThreshold = positiveMilliseconds(options.requestThreshold, 1000, 'requestThreshold', true);
    const recoveryInterval = Math.max(RECOVERY_RETRY_DELAY, positiveMilliseconds(options.recoveryInterval, RECOVERY_RETRY_DELAY, 'recoveryInterval'));
    const recoveryTimeout = positiveMilliseconds(options.recoveryTimeout, 250, 'recoveryTimeout');
    const macAddress = normalizeMacAddress(options.macAddress);
    if (options.recoverByMac === true && !macAddress) throw new Error('Zendure MAC recovery requires a valid macAddress.');
    const requestFn = options.requestFn || requestJson;
    const recoveryFinder = options.recoveryFinder || findZendureIpByMac;
    const now = options.now || Date.now;
    const configuredHost = origin.hostname;
    let activeHost = configuredHost;
    let cache = null;
    let inFlight = null;
    let lastRecoveryAttempt = null;
    let recoveryNotFound = false;
    let recoveryUnavailable = false;

    function getRecoveryState() {
        return {
            attempted: lastRecoveryAttempt !== null,
            enabled: options.recoverByMac === true,
            macAddress: options.macAddress || null,
            notFound: recoveryNotFound,
            unavailable: recoveryUnavailable,
            recoveredIp: activeHost !== configuredHost ? activeHost : null
        };
    }

    async function fetchReport(host, kind) {
        const url = new URL('/properties/report', origin);
        url.hostname = host;
        const response = await requestFn(url.href, timeout);
        if (!response || response.statusCode < 200 || response.statusCode >= 300 || !Number.isInteger(response.statusCode)) {
            throw new Error(`Zendure returned HTTP status ${response?.statusCode ?? 'unknown'}.`);
        }
        const validate = kind === 'battery' ? validateBatteryReport : validatePowerReport;
        validate(response.json, {...options, powerScale});
        return response.json;
    }

    async function fetchWithRecovery(kind) {
        try {
            const report = await fetchReport(activeHost, kind);
            recoveryNotFound = false;
            recoveryUnavailable = false;
            return report;
        } catch (error) {
            const currentTime = now();
            if (options.recoverByMac !== true || net.isIP(configuredHost) !== 4 ||
                ['EPERM', 'EACCES'].includes(error.code) ||
                (lastRecoveryAttempt !== null && currentTime - lastRecoveryAttempt < recoveryInterval)) throw error;
            lastRecoveryAttempt = currentTime;
            let result;
            try {
                result = await recoveryFinder({host: configuredHost, macAddress, timeout: recoveryTimeout, port: Number(origin.port) || 80});
            } catch { result = null; }
            const host = typeof result === 'string' ? result : result?.host;
            const prefix = configuredHost.split('.').slice(0, 3).join('.') + '.';
            recoveryNotFound = !host || net.isIP(host) !== 4 || !host.startsWith(prefix);
            recoveryUnavailable = result?.unavailable === true;
            if (recoveryNotFound) throw error;
            // Verify the report's serial and readiness before retaining its new address.
            const report = await fetchReport(host, kind);
            activeHost = host;
            recoveryNotFound = false;
            recoveryUnavailable = false;
            return report;
        }
    }

    function getReport(kind) {
        if (inFlight) return inFlight;
        const currentTime = now();
        if (cache && currentTime >= cache.requestedAt && currentTime - cache.requestedAt < requestThreshold) {
            return cache.error ? Promise.reject(cache.error) : Promise.resolve(cache);
        }
        cache = null;
        inFlight = fetchWithRecovery(kind).then(report => {
            const savedAt = now();
            cache = {report, requestedAt: currentTime, savedAt, time: Math.floor(savedAt / 1000)};
            return cache;
        }, error => {
            cache = {error, requestedAt: currentTime, savedAt: now()};
            throw error;
        }).finally(() => { inFlight = null; });
        return inFlight;
    }

    async function getPower() {
        const result = await getReport('power');
        return {...validatePowerReport(result.report, {...options, powerScale}), time: result.time};
    }

    async function getBattery() {
        const result = await getReport('battery');
        return {...validateBatteryReport(result.report, options), time: result.time};
    }

    async function getBatterySettings() {
        const result = await getReport('battery');
        validateBatteryReport(result.report, options);
        return {...parseBatterySettings(result.report), time: result.time};
    }

    function reqBatterySettings(callback) {
        getBatterySettings().then(value => callback(null, value), error => callback(error));
    }

    function reqPower(callback) {
        getPower().then(value => callback(null, value), error => callback(error));
    }

    function reqBattery(callback) {
        getBattery().then(value => callback(null, value), error => callback(error));
    }

    return {reqPower, reqBattery, reqBatterySettings, getPower, getBattery, getBatterySettings, getRecoveryState};
}

module.exports = {createZendureClient, validatePowerReport, validateBatteryReport, requestJson};
