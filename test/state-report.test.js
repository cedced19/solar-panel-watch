const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const main = require('../main');
const getPowerData = require('../lib/get-power-data');
const {createStateReport, reportFilename} = require('../lib/state-report');

const NOW = Date.parse('2026-10-27T10:15:30.000Z');
const nowSeconds = NOW / 1000;

const devices = [
    {uri: 'boiler', priority: 1, power_limit: 2300, time_limit: 2500, power_threshold_percentage: 0.04, ids: ['abc']},
    {uri: 'heater', priority: 2, power_limit: 1500, time_limit: 2500, power_threshold_percentage: 0.04, ids: ['def'],
        max_energy_time_range: '4h', max_energy_val: 6000}
];

function tempDevicesFile(t, content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-report-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const file = path.join(dir, 'devices-to-activate.json');
    if (content !== undefined) fs.writeFileSync(file, content);
    return file;
}

function connectedSources(overrides = {}) {
    return {
        getHousePowerSource: () => 'zendure',
        reqBattery: (callback) => callback(null, {
            socPercent: 86, state: 'charging', chargingPowerW: 345, dischargingPowerW: 0, time: nowSeconds - 3
        }),
        reqBatterySettings: (callback) => callback(null, {
            limits: {chargeTargetPercent: 100}, packs: [{serial: 'B1', socPercent: 86}], time: nowSeconds
        }),
        reqMeter: (callback) => callback(null, {power: -820, serial: 'M1', serialMatches: true, time: nowSeconds - 1}),
        reqShelly: (callback) => callback(null, {time: nowSeconds, emeters: [{power: -800, voltage: 231}, {power: 2800, voltage: 231}]}),
        getBatteryRecoveryState: () => ({recoveredIp: '192.168.0.41'}),
        getHouseRecoveryState: () => ({}),
        getShellyRecoveryState: () => ({}),
        ...overrides
    };
}

const closedGate = {enabled: false, reason: 'battery-charging-below-max', socPercent: 86, fullSocPercent: 100, maxChargingPowerW: 1500};
const openGate = {enabled: true, reason: 'battery-full', socPercent: 100, fullSocPercent: 100, maxChargingPowerW: 1500};

function decisionState(gate, deviceStates) {
    return {
        gate,
        batterySettings: {fullSocPercent: 100, maxChargingPowerW: 1500, maxChargingToleranceW: 20, ignoreState: false},
        powerDataAvailable: true,
        activatedDevicesPowerW: 1200,
        devices: devices.map((config, index) => ({
            config,
            state: deviceStates[index] ? {
                activated: false, last_call: NOW - 1000, last_power: 0, requested_alpha: 128, requested_toggle: false,
                requested_power: 0, type: 'normal', force_mode: false, force_mode_percent: 0, max_energy_reached: false,
                target_reached_over_period: false, last_control_var: NaN, ip: '192.168.0.60', ...deviceStates[index]
            } : null,
            connected: Boolean(deviceStates[index])
        }))
    };
}

async function buildReport(t, {sources = connectedSources(), decisions = decisionState(closedGate, []), devicesJson, timeout = 50, timezone = 'Europe/Paris'} = {}) {
    const devicesPath = tempDevicesFile(t, devicesJson === undefined ? JSON.stringify(devices, null, 4) + '\n' : devicesJson);
    const report = createStateReport({
        sources, getDecisionState: () => decisions, devicesPath, runningDevices: devices, timezone, timeout, now: () => NOW
    });
    return report.build();
}

function line(text, key) {
    const match = text.split('\n').find((candidate) => candidate.startsWith(key + ': '));
    assert.ok(match, `the report has no "${key}" line`);
    return match.slice(key.length + 2);
}

function section(text, title) {
    const start = text.indexOf(title);
    assert.notEqual(start, -1, `the report has no "${title}" section`);
    const next = text.indexOf('\n## ', start + 1);
    return text.slice(start, next === -1 ? undefined : next);
}

test('the report is named after its UTC time and written for a text download', async (t) => {
    assert.equal(reportFilename(NOW), 'solar-panel-watch-report-20261027T101530Z.txt');
    const report = await buildReport(t);
    assert.equal(report.filename, 'solar-panel-watch-report-20261027T101530Z.txt');
    assert.match(report.text, /^# Solar Panel Watch - state report\ngenerated_utc: 2026-10-27T10:15:30.000Z\ngenerated_local: 2026-10-27 11:15:30 \(Europe\/Paris\)\n/);
    assert.ok(report.text.endsWith('\n'));
});

test('the report shows the readings of the battery, the Zendure sensor and the Shelly', async (t) => {
    const {text} = await buildReport(t);

    const battery = section(text, '## 1. Battery');
    assert.equal(line(battery, 'status'), 'CONNECTED');
    assert.equal(line(battery, 'socPercent'), '86');
    assert.equal(line(battery, 'chargingPowerW'), '345');
    assert.equal(line(battery, 'reading_age_s'), '3');
    assert.equal(line(battery, 'recovery.recoveredIp'), '192.168.0.41');
    assert.equal(line(battery, 'limits.chargeTargetPercent'), '100');
    assert.equal(line(battery, 'packs[0].serial'), 'B1');

    const sensor = section(text, '## 2. Zendure sensor');
    assert.equal(line(sensor, 'status'), 'CONNECTED');
    assert.equal(line(sensor, 'house_power_w'), '-820');
    assert.equal(line(sensor, 'serial_matches_config'), 'true');

    const shelly = section(text, '## 3. Shelly');
    assert.equal(line(shelly, 'status'), 'CONNECTED');
    assert.equal(line(shelly, 'emeters[0].power'), '-800');
    assert.equal(line(shelly, 'emeters[1].power'), '2800');
    assert.match(shelly, /role: solar production \(emeters\[1\]\); house power comes from the Zendure sensor/);

    assert.match(text, /^battery: CONNECTED \(charge 86 %, state charging, charging 345 W, discharging 0 W\)$/m);
    assert.match(text, /^zendure_sensor: CONNECTED \(house power -820 W\)$/m);
    assert.match(text, /^shelly: CONNECTED \(emeters\[0\] -800 W, emeters\[1\] 2800 W\)$/m);
});

test('a source that fails, throws or stays silent is not connected and the rest of the report is kept', async (t) => {
    const {text} = await buildReport(t, {
        sources: connectedSources({
            reqBattery: (callback) => callback(new Error('Zendure request timed out.')),
            reqBatterySettings: () => {}, // never answers
            reqMeter: () => { throw new Error('Zendure host is invalid.'); },
            reqShelly: (callback) => callback(null, null)
        })
    });

    const battery = section(text, '## 1. Battery');
    assert.match(battery, /^status: NOT CONNECTED\nerror: Zendure request timed out\.$/m);
    assert.match(battery, /^status: NOT AVAILABLE\nerror: no answer within 50 ms$/m);
    assert.match(section(text, '## 2. Zendure sensor'), /^status: NOT CONNECTED\nerror: Zendure host is invalid\.$/m);
    assert.match(section(text, '## 3. Shelly'), /^status: NOT CONNECTED\nerror: empty answer$/m);
    assert.match(text, /^battery: NOT CONNECTED \(Zendure request timed out\.\)$/m);
    assert.equal(line(text, 'house_power_w'), 'n/a');
    assert.match(section(text, '## 5. devices-to-activate.json'), /"uri": "boiler"/);
});

test('with the Shelly as house power source the Zendure sensor is not read', async (t) => {
    const {text} = await buildReport(t, {
        sources: connectedSources({
            getHousePowerSource: () => 'shelly',
            reqMeter: () => assert.fail('the Zendure sensor must not be read')
        })
    });
    assert.match(section(text, '## 2. Zendure sensor'), /^status: NOT USED\nreason: house_power_source is "shelly"/m);
    assert.match(text, /^zendure_sensor: NOT USED$/m);
    assert.match(section(text, '## 3. Shelly'), /^role: house power \(emeters\[0\]\) and solar production \(emeters\[1\]\)$/m);
    assert.equal(line(text, 'house_power_w'), '-800');
});

test('the decisions explain the gate, the available power and why each device is on or off', async (t) => {
    const {text} = await buildReport(t, {
        decisions: decisionState(closedGate, [
            {type: 'normal', force_mode: true, force_mode_percent: 1, requested_toggle: true, requested_power: 2300, last_power: 2300},
            undefined
        ])
    });
    const decisions = section(text, '## 4. Device decisions');
    assert.equal(line(decisions, 'gate_open'), 'false');
    assert.equal(line(decisions, 'gate_reason'), 'battery-charging-below-max');
    assert.match(line(decisions, 'gate_meaning'), /^devices BLOCKED/);
    assert.equal(line(decisions, 'house_power_w (zendure)'), '-820');
    assert.equal(line(decisions, 'activated_devices_power_w'), '1200');
    assert.equal(line(decisions, 'available_power_w'), '2020');
    assert.equal(line(decisions, 'config_max_charging_tolerance_w'), '20');

    const boiler = section(decisions, '### Device boiler');
    assert.equal(line(boiler, 'decision'), 'ON, asked to draw 2300 W (forced)');
    assert.equal(line(boiler, 'force_level_fraction'), '1');
    assert.equal(line(boiler, 'blockers'), 'none');
    assert.equal(line(boiler, 'last_control_var'), 'n/a');
    assert.match(section(decisions, '### Device heater'), /status: never connected since the app started/);
    assert.match(text, /^device_gate: CLOSED \(battery-charging-below-max\)$/m);
    assert.match(text, /^devices: 2 configured, 1 connected, 1 running$/m);
});

test('an off device lists what blocks it, or says nothing does', async (t) => {
    const blocked = await buildReport(t, {
        decisions: decisionState(closedGate, [
            {type: 'advanced', last_alpha: 128},
            {type: 'normal', max_energy_reached: true}
        ])
    });
    const boiler = section(blocked.text, '### Device boiler');
    assert.equal(line(boiler, 'blockers'), 'battery gate closed (battery-charging-below-max)');
    assert.match(line(boiler, 'decision'), /^OFF, blocked by: battery gate closed/);
    assert.equal(line(boiler, 'requested_alpha'), '128 (128 = off, lower = more power)');
    assert.equal(
        line(section(blocked.text, '### Device heater'), 'blockers'),
        'battery gate closed (battery-charging-below-max); max energy reached (6000 Wh over 4h)'
    );

    const free = await buildReport(t, {
        decisions: decisionState(openGate, [
            {type: 'advanced', requested_alpha: 90, requested_power: 1200, last_power: 1200},
            {type: 'normal', max_energy_reached: true}
        ])
    });
    assert.equal(line(section(free.text, '### Device boiler'), 'decision'), 'ON, asked to draw 1200 W');
    const heater = section(free.text, '### Device heater');
    assert.equal(line(heater, 'blockers'), 'max energy reached (6000 Wh over 4h)');

    const idle = await buildReport(t, {decisions: decisionState(openGate, [{type: 'normal'}, {type: 'normal'}])});
    assert.match(line(section(idle.text, '### Device heater'), 'decision'), /^OFF, nothing blocks it/);
});

test('a control variable above its maximum blocks the device', async (t) => {
    const withLimit = [{...devices[0], max_control_var_val: 55, period_after_target: '15m'}, devices[1]];
    const decisions = decisionState(openGate, [{type: 'normal', last_control_var: 57}, undefined]);
    decisions.devices[0].config = withLimit[0];
    const {text} = await buildReport(t, {decisions});
    assert.equal(line(section(text, '### Device boiler'), 'blockers'), 'control variable 57 above its maximum 55');
});

test('the report contains the devices file as it is and flags a file that differs from the running devices', async (t) => {
    const unchanged = await buildReport(t);
    const file = section(unchanged.text, '## 5. devices-to-activate.json');
    assert.equal(line(file, 'matches_running_configuration'), 'true');
    assert.ok(file.includes('```json\n' + JSON.stringify(devices, null, 4) + '\n```'));

    const edited = JSON.stringify([{...devices[0], power_limit: 1800}, devices[1]], null, 2);
    const changed = await buildReport(t, {devicesJson: edited});
    const changedFile = section(changed.text, '## 5. devices-to-activate.json');
    assert.equal(line(changedFile, 'matches_running_configuration'), 'false');
    assert.match(changedFile, /warning: the app runs the devices it started with; a restart is needed/);
    assert.ok(changedFile.includes('"power_limit": 1800'));

    const broken = await buildReport(t, {devicesJson: '[{"uri": '});
    const brokenFile = section(broken.text, '## 5. devices-to-activate.json');
    assert.equal(line(brokenFile, 'matches_running_configuration'), 'n/a');
    assert.match(brokenFile, /warning: the file is not valid JSON/);
    assert.ok(brokenFile.includes('[{"uri":'));

    const devicesPath = path.join(os.tmpdir(), 'state-report-missing', 'devices-to-activate.json');
    const missing = await createStateReport({
        sources: connectedSources(), getDecisionState: () => decisionState(openGate, []), devicesPath, runningDevices: devices, now: () => NOW
    }).build();
    assert.match(section(missing.text, '## 5. devices-to-activate.json'), /^status: NOT READABLE\nerror: ENOENT/m);
});

test('the report leaves the configuration secrets out', async (t) => {
    const config = require('../config.json');
    const {text} = await buildReport(t);
    for (const secret of [config.auth && config.auth.jwt_secret, config.auth && config.auth.sender && config.auth.sender.pass]) {
        if (secret) assert.equal(text.includes(secret), false);
    }
});

function request(server, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get({host: '127.0.0.1', port: server.address().port, path: urlPath, headers}, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body}));
        }).on('error', reject);
    });
}

test('GET /api/report downloads the state even while the devices are unreachable, and the dashboard links it', async (t) => {
    const server = await new Promise((resolve) => {
        const listening = main.app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const originals = {...getPowerData};
    t.after(() => {
        Object.assign(getPowerData, originals);
        server.close();
    });
    getPowerData.getHousePowerSource = () => 'zendure';
    getPowerData.req = (callback) => callback(null, {emeters: [{power: -500}, {power: 1000}]});
    getPowerData.reqBattery = (callback) => callback(null, {
        socPercent: 86, state: 'charging', chargingPowerW: 345, dischargingPowerW: 300
    });
    getPowerData.reqBatterySettings = (callback) => callback(new Error('Zendure battery settings are unavailable.'));
    getPowerData.reqMeter = (callback) => callback(null, {power: -500, time: Math.floor(Date.now() / 1000)});
    getPowerData.reqShelly = (callback) => callback(new Error('Shelly request timed out.'));
    getPowerData.getBatteryRecoveryState = () => ({});
    getPowerData.getHouseRecoveryState = () => ({});
    getPowerData.getShellyRecoveryState = () => ({});

    const page = await request(server, '/');
    assert.match(page.body, /<a class="action-button" href="\/api\/report">/);
    assert.match(page.body, /Download report/);
    const french = await request(server, '/', {'accept-language': 'fr'});
    assert.match(french.body, /Télécharger le rapport/);

    const report = await request(server, '/api/report');
    assert.equal(report.status, 200);
    assert.match(report.headers['content-type'], /^text\/plain; charset=utf-8/);
    assert.match(report.headers['content-disposition'], /^attachment; filename="solar-panel-watch-report-\d{8}T\d{6}Z\.txt"$/);
    assert.equal(report.headers['cache-control'], 'no-store');
    assert.equal(line(section(report.body, '## 1. Battery'), 'socPercent'), '86');
    assert.equal(line(section(report.body, '## 2. Zendure sensor'), 'house_power_w'), '-500');
    assert.match(section(report.body, '## 3. Shelly'), /^status: NOT CONNECTED\nerror: Shelly request timed out\.$/m);
    assert.match(section(report.body, '## 4. Device decisions'), /### Device chauffe-eau\n/);
    assert.match(section(report.body, '## 5. devices-to-activate.json'), /"uri": "chauffe-eau"/);

    // The report is also offered on the page shown while the house power is unavailable.
    getPowerData.req = (callback) => callback(new Error('Zendure is unreachable'));
    const unavailable = await request(server, '/');
    assert.equal(unavailable.status, 503);
    assert.match(unavailable.body, /href="\/api\/report"/);
});
