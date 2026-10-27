'use strict';

// Plain-text report of the current state, downloaded from the dashboard (GET /api/report,
// see main.js). It is written to be handed to an AI agent as it is: every value carries its
// unit in its name, every source says whether it is connected, and the decision rules are
// summarised at the top.
//
// Sections: battery, Zendure sensor (house power meter), Shelly, device decisions and the
// current devices-to-activate.json. config.json is left out on purpose, it holds secrets.
//
// collect() reads the devices and the controller, renderReport() turns that snapshot into text
// and does no I/O, so the format can be tested without any device.
//
// options.sources         callback readers {reqBattery, reqBatterySettings, reqMeter, reqShelly}
//                         and getHousePowerSource, get{Battery,House,Shelly}RecoveryState (the shape
//                         of lib/get-power-data.js). They are looked up at each report.
// options.getDecisionState  returns what the controller of main.js currently decides:
//                         {gate, batterySettings, powerDataAvailable, activatedDevicesPowerW,
//                          devices: [{config, state | null, connected}]} in priority order
// options.devicesPath     devices-to-activate.json, read at each report
// options.runningDevices  the devices the process started with (to tell if the file changed since)
// options.timezone        IANA name for the local time of the header (default: server time zone)
// options.timeout         milliseconds to wait for each device (default 5000)
// options.now             () => milliseconds, for tests

const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 5000;
const ALPHA_OFF = 128; // advanced devices: alpha 128 is off, a lower alpha lets more power through

// The reasons of lib/battery-logic.js getDeviceActivation.
const GATE_MEANINGS = {
    'battery-full': 'devices MAY run: the battery is at or above its full level',
    'battery-charging-at-max': 'devices MAY run: the battery already charges at its maximum power, the surplus is free',
    'battery-not-full': 'devices BLOCKED: the battery is neither charging nor full, it must charge first',
    'battery-charging-below-max': 'devices BLOCKED: the battery still has room to take more charging power',
    'battery-discharging': 'devices BLOCKED: the battery is discharging',
    'battery-unavailable': 'devices BLOCKED: no fresh battery reading (safety mode)',
    'power-unavailable': 'devices BLOCKED: the house power meter gives no valid value (safety mode)'
};

const LEGEND = [
    '## How to read this report',
    '- Plain text. Sections start with "## ". Most lines are "key: value"; "n/a" means not available or not reported.',
    '- Units are the suffix of the key: _w / W watts, _wh watt-hours, _percent / Percent %, _v / V volts, _c / C degrees Celsius,',
    '  _ms milliseconds, _s seconds, Minutes, Dbm.',
    '- Times are UTC (ISO 8601). "reading_age_s" is how old the reading is when the report is made.',
    '- House power is measured at the grid connection: positive = importing from the grid, negative = exporting the solar surplus.',
    '- A source that does not answer is "NOT CONNECTED" with the error text; the other sections stay valid.',
    '- How devices are decided: (1) a forced device runs at its forced level, whatever the battery does; (2) any other device',
    '  needs the battery gate to be open (section 4); (3) then, in priority order (1 first), the exported surplus power decides,',
    '  unless a limit stops the device (maximum energy over a period, control variable target).',
    '- config.json (secrets) is not part of this report.'
];

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorText(error) {
    return error && error.message ? error.message : String(error);
}

// Settles with {ok: true, data} or {ok: false, error}; never rejects and gives up after
// timeout milliseconds, so one silent device cannot hold the whole report back.
function read(reader, timeout) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ok: false, error: `no answer within ${timeout} ms`}), timeout);
        const settle = (outcome) => {
            clearTimeout(timer);
            resolve(outcome);
        };
        try {
            reader((error, data) => {
                if (error) return settle({ok: false, error: errorText(error)});
                settle(data == null ? {ok: false, error: 'empty answer'} : {ok: true, data});
            });
        } catch (error) {
            settle({ok: false, error: errorText(error)});
        }
    });
}

// State of a client that may not exist (yet) or may not implement it.
function recoveryState(sources, method) {
    try {
        const state = typeof sources[method] === 'function' ? sources[method]() : null;
        return isPlainObject(state) ? state : {};
    } catch (error) {
        return {};
    }
}

function readDevicesFile(devicesPath, runningDevices) {
    const file = path.basename(devicesPath);
    let text;
    try {
        text = fs.readFileSync(devicesPath, 'utf8');
    } catch (error) {
        return {file, error: errorText(error)};
    }
    try {
        return {file, text, matchesRunning: JSON.stringify(JSON.parse(text)) === JSON.stringify(runningDevices)};
    } catch (error) {
        return {file, text, parseError: errorText(error)};
    }
}

// ---- formatting ----

function text(value) {
    if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return 'n/a';
    return String(value);
}

function lines(entries) {
    return entries.map(([key, value]) => `${key}: ${text(value)}`);
}

// One [key, value] per leaf: {a: {b: 1}, list: ['x']} gives [['a.b', 1], ['list[0]', 'x']].
function flatten(value, prefix = '') {
    if (Array.isArray(value)) {
        return value.length ? value.flatMap((item, index) => flatten(item, `${prefix}[${index}]`)) : [[prefix, '[]']];
    }
    if (isPlainObject(value)) {
        const entries = Object.entries(value).flatMap(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key));
        return entries.length ? entries : [[prefix, '{}']];
    }
    return [[prefix, value]];
}

function utc(milliseconds) {
    return new Date(milliseconds).toISOString();
}

function localTime(milliseconds, timezone) {
    try {
        return new Intl.DateTimeFormat('sv-SE', {timeZone: timezone, dateStyle: 'short', timeStyle: 'medium'}).format(milliseconds);
    } catch (error) {
        return null; // unknown time zone name
    }
}

// Devices report the time of a reading in Unix seconds.
function readingTime(unixSeconds, now) {
    return Number.isFinite(unixSeconds) && unixSeconds > 0 ?
        [['reading_time_utc', utc(unixSeconds * 1000)], ['reading_age_s', Math.round(now / 1000 - unixSeconds)]] :
        [['reading_time_utc', null], ['reading_age_s', null]];
}

function sourceStatus(outcome) {
    return outcome.ok ? ['status: CONNECTED'] : ['status: NOT CONNECTED', `error: ${outcome.error}`];
}

function recoveryLines(state) {
    return Object.keys(state).length ? lines(flatten(state, 'recovery')) : [];
}

// ---- sections ----

function header({now, source, timezone}) {
    const local = localTime(now, timezone);
    return [
        '# Solar Panel Watch - state report',
        `generated_utc: ${utc(now)}`,
        ...(local ? [`generated_local: ${local} (${timezone || 'server time zone'})`] : []),
        `app_uptime_s: ${Math.round(process.uptime())}`,
        `house_power_source: ${source}`
    ];
}

function emeterPower(shellyData, index) {
    const meter = Array.isArray(shellyData.emeters) ? shellyData.emeters[index] : null;
    return meter ? meter.power : null;
}

function describeSource(outcome, describe) {
    return outcome === null ? 'NOT USED' : outcome.ok ? `CONNECTED (${describe(outcome.data)})` : `NOT CONNECTED (${outcome.error})`;
}

function summary(snapshot) {
    const {battery, meter, shelly, decisions, housePowerW} = snapshot;
    const {gate, devices} = decisions;
    const running = devices.filter((device) => device.state && isRunning(device.state)).length;
    return [
        '## Summary',
        `battery: ${describeSource(battery, (data) => `charge ${text(data.socPercent)} %, state ${text(data.state)}, charging ${text(data.chargingPowerW)} W, discharging ${text(data.dischargingPowerW)} W`)}`,
        `zendure_sensor: ${describeSource(meter, (data) => `house power ${text(data.power)} W`)}`,
        `shelly: ${describeSource(shelly, (data) => `emeters[0] ${text(emeterPower(data, 0))} W, emeters[1] ${text(emeterPower(data, 1))} W`)}`,
        `house_power_w: ${text(housePowerW)}`,
        `device_gate: ${gate.enabled ? 'OPEN' : 'CLOSED'} (${gate.reason})`,
        `devices: ${devices.length} configured, ${devices.filter((device) => device.connected).length} connected, ${running} running`
    ];
}

function batterySection({battery, batterySettings, recovery, now}) {
    const out = ['## 1. Battery (Zendure SolarFlow)', ...sourceStatus(battery)];
    if (battery.ok) {
        const {time, ...values} = battery.data;
        out.push(...lines([...readingTime(time, now), ...flatten(values)]));
    }
    out.push(...recoveryLines(recovery.battery), '', '### Battery settings and diagnostics');
    if (batterySettings.ok) {
        const {time, ...values} = batterySettings.data;
        out.push(...lines(flatten(values)));
    } else {
        out.push('status: NOT AVAILABLE', `error: ${batterySettings.error}`);
    }
    return out;
}

function meterSection({meter, source, recovery, now}) {
    const out = ['## 2. Zendure sensor (house power meter)'];
    if (meter === null) {
        return [...out, 'status: NOT USED', `reason: house_power_source is "${source}", so the Zendure sensor is not read`];
    }
    out.push('role: house power (grid import/export) used by the device decisions', ...sourceStatus(meter));
    if (meter.ok) {
        out.push(...lines([
            ['house_power_w', meter.data.power], ['serial', meter.data.serial], ['serial_matches_config', meter.data.serialMatches],
            ...readingTime(meter.data.time, now)
        ]));
    }
    return [...out, ...recoveryLines(recovery.meter)];
}

function shellySection({shelly, source, recovery, now}) {
    const role = source === 'shelly' ?
        'house power (emeters[0]) and solar production (emeters[1])' :
        'solar production (emeters[1]); house power comes from the Zendure sensor';
    const out = ['## 3. Shelly (energy meter)', `role: ${role}`, ...sourceStatus(shelly)];
    if (shelly.ok) {
        out.push(
            'emeter fields: power W, reactive VAR, pf power factor, voltage V, total Wh imported, total_returned Wh exported',
            ...lines([['reading_time_utc (Shelly clock)', Number.isFinite(shelly.data.time) && shelly.data.time > 0 ? utc(shelly.data.time * 1000) : null]]),
            ...lines(flatten(shelly.data.emeters, 'emeters'))
        );
    }
    return [...out, ...recoveryLines(recovery.shelly)];
}

function isRunning(state) {
    return state.type === 'advanced' ? state.requested_alpha < ALPHA_OFF : state.requested_toggle === true;
}

// What keeps a device off right now (read only; main.js has the rules).
function deviceBlockers(device, state, connected, gate) {
    const blockers = [];
    if (!connected) blockers.push('device not connected (no recent call)');
    if (!state.force_mode && !gate.enabled) blockers.push(`battery gate closed (${gate.reason})`);
    if (state.max_energy_reached) blockers.push(`max energy reached (${device.max_energy_val} Wh over ${device.max_energy_time_range})`);
    if (state.target_reached_over_period) blockers.push(`control variable target reached within the last ${device.period_after_target}`);
    if (Number.isFinite(device.max_control_var_val) && Number.isFinite(state.last_control_var) && state.last_control_var > device.max_control_var_val) {
        blockers.push(`control variable ${state.last_control_var} above its maximum ${device.max_control_var_val}`);
    }
    return blockers;
}

function deviceSection({config: device, state, connected}, gate, now) {
    const out = [`### Device ${device.uri}`, ...lines([['priority', device.priority]])];
    if (!state) {
        return [...out, 'status: never connected since the app started (no state, no decision yet)'];
    }
    const blockers = deviceBlockers(device, state, connected, gate);
    let decision;
    if (isRunning(state)) {
        decision = `ON, asked to draw ${text(state.requested_power)} W${state.force_mode ? ' (forced)' : ''}`;
    } else if (blockers.length) {
        decision = `OFF, blocked by: ${blockers.join('; ')}`;
    } else {
        decision = 'OFF, nothing blocks it: the exported surplus is too small for this device (inferred)';
    }
    const type = state.type === 'advanced' ?
        [['requested_alpha', `${text(state.requested_alpha)} (${ALPHA_OFF} = off, lower = more power)`], ['last_alpha', state.last_alpha]] :
        [['requested_toggle', state.requested_toggle]];
    return [
        ...out,
        ...lines([
            ['decision', decision],
            ['type', state.type],
            ['connected', connected],
            ['last_call_utc', utc(state.last_call)],
            ['last_call_age_s', Math.round((now - state.last_call) / 1000)],
            ['client_ip', state.ip],
            ...type,
            ['requested_power_w', state.requested_power],
            ['last_power_w', state.last_power],
            ['force_mode', state.force_mode],
            ['force_level_fraction', state.force_mode ? state.force_mode_percent : null],
            ['max_energy_reached', state.max_energy_reached],
            ['target_reached_over_period', state.target_reached_over_period],
            ['last_control_var', state.last_control_var],
            ['blockers', blockers.length ? blockers.join('; ') : 'none']
        ])
    ];
}

function decisionsSection({decisions, housePowerW, source, now}) {
    const {gate, batterySettings, powerDataAvailable, activatedDevicesPowerW, devices} = decisions;
    const availablePowerW = housePowerW === null ? null : activatedDevicesPowerW + Math.max(-housePowerW, 0);
    const out = [
        '## 4. Device decisions',
        '',
        '### Battery gate (decides for every device that is not forced)',
        ...lines([
            ['gate_open', gate.enabled],
            ['gate_reason', gate.reason],
            ['gate_meaning', GATE_MEANINGS[gate.reason] || 'unknown reason'],
            ['battery_soc_percent', gate.socPercent],
            ['full_soc_percent', gate.fullSocPercent],
            ['max_charging_power_w', gate.maxChargingPowerW],
            ['house_power_valid', powerDataAvailable],
            ['config_full_soc_percent', batterySettings.fullSocPercent],
            ['config_max_charging_power_w', batterySettings.maxChargingPowerW],
            ['config_max_charging_tolerance_w', batterySettings.maxChargingToleranceW],
            ['config_ignore_battery_state', batterySettings.ignoreState]
        ]),
        'note: full_soc_percent and max_charging_power_w are the limits Zendure reports, or the configured ones when it does not.',
        'note: the gate is the controller\'s own view, from the readings it polls itself; it can lag sections 1-3 by a few seconds.',
        '',
        '### Power available to the devices',
        ...lines([
            [`house_power_w (${source})`, housePowerW],
            ['activated_devices_power_w', activatedDevicesPowerW],
            ['available_power_w', availablePowerW]
        ]),
        'note: available_power_w = activated_devices_power_w + the exported power (as on the dashboard).',
        ''
    ];
    if (!devices.length) return [...out, 'No device is configured.'];
    devices.forEach((device, index) => out.push(...(index ? [''] : []), ...deviceSection(device, gate, now)));
    return out;
}

function devicesFileSection({devicesFile}) {
    const out = ['## 5. devices-to-activate.json (current content of the file)', `file: ${devicesFile.file}`];
    if (devicesFile.error) return [...out, 'status: NOT READABLE', `error: ${devicesFile.error}`];
    if (devicesFile.parseError) {
        out.push('matches_running_configuration: n/a', `warning: the file is not valid JSON (${devicesFile.parseError})`);
    } else {
        out.push(`matches_running_configuration: ${devicesFile.matchesRunning}`);
        if (!devicesFile.matchesRunning) {
            out.push('warning: the app runs the devices it started with; a restart is needed to apply this file.');
        }
    }
    return [...out, 'content:', '```json', devicesFile.text.replace(/\s+$/, ''), '```'];
}

// snapshot: what collect() returns.
function renderReport(snapshot) {
    const housePowerW = houseValue(snapshot);
    const full = {...snapshot, housePowerW};
    return [
        ...header(full), '',
        ...LEGEND, '',
        ...summary(full), '',
        ...batterySection(full), '',
        ...meterSection(full), '',
        ...shellySection(full), '',
        ...decisionsSection(full), '',
        ...devicesFileSection(full)
    ].join('\n') + '\n';
}

// The house power of the configured source, the one the device decisions use.
function houseValue({source, meter, shelly}) {
    const power = source === 'zendure' ?
        meter && meter.ok && meter.data.power :
        shelly.ok && emeterPower(shelly.data, 0);
    return Number.isFinite(power) ? power : null;
}

function reportFilename(now) {
    return `solar-panel-watch-report-${utc(now).replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '')}.txt`;
}

function createStateReport(options) {
    const {sources, getDecisionState, devicesPath, runningDevices, timezone} = options;
    const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
    const now = options.now || Date.now;

    // All devices are asked together; the Zendure sensor is only asked when it supplies the house power.
    async function collect() {
        const source = sources.getHousePowerSource();
        const [battery, batterySettings, meter, shelly] = await Promise.all([
            read((callback) => sources.reqBattery(callback), timeout),
            read((callback) => sources.reqBatterySettings(callback), timeout),
            source === 'zendure' ? read((callback) => sources.reqMeter(callback), timeout) : null,
            read((callback) => sources.reqShelly(callback), timeout)
        ]);
        return {
            now: now(),
            timezone,
            source,
            battery,
            batterySettings,
            meter,
            shelly,
            recovery: {
                battery: recoveryState(sources, 'getBatteryRecoveryState'),
                meter: source === 'zendure' ? recoveryState(sources, 'getHouseRecoveryState') : {},
                shelly: recoveryState(sources, 'getShellyRecoveryState')
            },
            // Read after the devices: the controller's gate then reflects the same readings.
            decisions: getDecisionState(),
            devicesFile: readDevicesFile(devicesPath, runningDevices)
        };
    }

    async function build() {
        const snapshot = await collect();
        return {filename: reportFilename(snapshot.now), text: renderReport(snapshot)};
    }

    return {build, collect};
}

module.exports = {createStateReport, renderReport, reportFilename};
