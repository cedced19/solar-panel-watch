const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const {createRequire} = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const mainPath = path.resolve(__dirname, '../main.js');
const requireFromMain = createRequire(mainPath);
const mainSource = fs.readFileSync(mainPath, 'utf8');

// Execute the real server and control loop with no hardware, database, disk writes,
// or running background timers. The callbacks are invoked by each test.
async function createServer(t, {minSoc = 80, omitMinSoc = false} = {}) {
    const intervals = [];
    const readings = {battery: {socPercent: 81, state: 'charging'}, power: -3000};
    const devices = [
        {uri: 'normal', ids: ['normal-id'], priority: 1, power_limit: 1000,
            power_threshold_percentage: 0.02, time_limit: 2500},
        {uri: 'advanced', ids: ['advanced-id'], priority: 2, power_limit: 1000,
            power_threshold_percentage: 0.02, time_limit: 2500, min_alpha: 40}
    ];
    const config = {...requireFromMain('./config.json'), force_mode_pass: 'test-pass'};
    if (omitMinSoc) {
        delete config.zendure_battery_min_soc;
    } else {
        config.zendure_battery_min_soc = minSoc;
    }
    const powerData = {
        powerRequestThreshold: 1000,
        batteryRequestThreshold: 20000,
        req(callback) {
            callback(readings.powerError || null, {
                emeters: [{power: readings.power}, {power: null}]
            });
        },
        reqBattery(callback) {
            callback(readings.batteryError || null, readings.battery);
        },
        getHousePowerSource: () => 'zendure',
        getHouseRecoveryState: () => ({}),
        getShellyRecoveryState: () => ({})
    };
    const database = {
        post(_entry, callback) { callback?.(); },
        save(callback) { callback?.(); },
        getAll: () => []
    };
    const batteryHistory = {points: [], queries: [], writes: [], csvCalls: []};
    const influx = {
        daemon() {}, writePower() {}, writePowerRaw() {}, writeNetworkData() {},
        writeVar() {}, requestLastVar: async () => [], requestVarOverPeriod: async () => [],
        getMaxValueOverData: () => 0,
        writeBatteryLevel(debug, battery) {
            batteryHistory.writes.push({debug, battery: {...battery}});
        },
        requestBatteryLevelOverPeriod(period) {
            batteryHistory.queries.push(period);
            return batteryHistory.error ? Promise.reject(batteryHistory.error) :
                Promise.resolve(batteryHistory.points);
        },
        pointsToCSV(points) {
            batteryHistory.csvCalls.push(points);
            return '_time,_value\n' + points.map((point) => `${point._time},${point._value}`).join('\n');
        }
    };
    const module = {exports: {}};
    const sandbox = {
        module, exports: module.exports, __dirname: path.dirname(mainPath),
        __filename: mainPath, Buffer, process,
        console: {log() {}, error() {}},
        setInterval(callback, delay) { intervals.push({callback, delay}); },
        require(name) {
            if (name === './lib/get-power-data.js') return powerData;
            if (name === './lib/influx-lib.js') return influx;
            if (name === './lib/compute-energy-device.js') return (_period, _uri, cb) => cb(null, 0);
            if (name === './config.json') return config;
            if (name === './devices-to-activate.json') return devices;
            if (name === 'json-store-list') return () => database;
            if (name === 'morgan') return () => (_req, _res, next) => next();
            if (name === 'fs') return {...fs, existsSync: () => false, mkdirSync() {},
                writeFile(_name, _contents, callback) { callback(null); }};
            return requireFromMain(name);
        }
    };
    vm.runInNewContext(mainSource, sandbox, {filename: mainPath});
    const main = module.exports;
    const server = await new Promise((resolve) => {
        const listener = main.app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));

    function request(route, headers = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({host: '127.0.0.1', port: server.address().port,
                path: route, headers}, (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => resolve({status: res.statusCode, body,
                    contentType: res.headers['content-type'],
                    json: res.headers['content-type']?.includes('application/json') ? JSON.parse(body) : null}));
            });
            req.on('error', reject);
            req.end();
        });
    }
    function startBackgroundTasks() {
        main.startBackgroundTasks();
    }
    function controlTick() {
        const control = intervals.find(({delay}) => delay === powerData.powerRequestThreshold);
        assert.ok(control, 'power control interval is registered');
        control.callback();
    }
    function batteryTick() {
        const battery = intervals.find(({delay}) => delay === powerData.batteryRequestThreshold);
        assert.ok(battery, 'battery polling interval is registered');
        battery.callback();
    }
    async function initializeDevices() {
        await request('/api/data');
        await request('/api/battery');
        await request('/api/device/normal/');
        await request('/api/device/advanced/advanced/');
        startBackgroundTasks();
    }
    async function assertDevicesOff() {
        for (const route of ['/api/device/normal/', '/api/device/id/normal-id/']) {
            assert.deepEqual((await request(route)).json, {toggle: false, time_limit: 2500});
        }
        for (const route of ['/api/device/advanced/advanced/', '/api/device/id/advanced-id/advanced/']) {
            assert.deepEqual((await request(route)).json, {alpha: 128, time_limit: 2500});
        }
    }
    async function assertRequestedPowerOff() {
        for (const uri of ['normal', 'advanced']) {
            const debug = (await request(`/api/device/${uri}/debug/`)).json;
            assert.equal(debug.requested_power, 0);
            assert.equal(debug.toggle, false);
            assert.equal(debug.requested_alpha, 128);
        }
    }
    return {main, readings, batteryHistory, request, startBackgroundTasks, controlTick, batteryTick,
        initializeDevices, assertDevicesOff, assertRequestedPowerOff};
}

function status(enabled, reason, socPercent, minSocPercent = 80) {
    return {enabled, reason, minSocPercent, socPercent};
}

test('battery gating keeps devices off at startup until both readings are known', async (t) => {
    const app = await createServer(t);
    assert.equal(app.main.getDeviceChargingStatus().enabled, false);
    await app.assertDevicesOff();
    const battery = await app.request('/api/battery');
    assert.deepEqual(battery.json.device_charging, status(false, 'power-unavailable', 81));
    await app.assertDevicesOff();
    const power = await app.request('/api/data');
    assert.deepEqual(power.json.device_charging, status(true, 'soc-above-threshold', 81));
});

test('surplus enables both device modes only strictly above the configured battery threshold', async (t) => {
    const app = await createServer(t, {minSoc: 65});
    app.readings.battery.socPercent = 66;
    await app.initializeDevices();
    app.controlTick();
    for (const route of ['/api/device/normal/', '/api/device/id/normal-id/']) {
        assert.equal((await app.request(route)).json.toggle, true);
    }
    for (const route of ['/api/device/advanced/advanced/', '/api/device/id/advanced-id/advanced/']) {
        assert.ok((await app.request(route)).json.alpha < 128);
    }
    for (const soc of [65, 64]) {
        app.readings.battery.socPercent = soc;
        const battery = await app.request('/api/battery');
        assert.deepEqual(battery.json.device_charging,
            status(false, 'soc-at-or-below-threshold', soc, 65));
        app.controlTick();
        await app.assertRequestedPowerOff();
        await app.assertDevicesOff();
    }
    app.readings.battery.socPercent = 66;
    await app.request('/api/battery');
    app.controlTick();
    assert.equal((await app.request('/api/device/id/normal-id/')).json.toggle, true);
    assert.ok((await app.request('/api/device/id/advanced-id/advanced/')).json.alpha < 128);
});

test('battery gating overrides forced operation and clears pending device power', async (t) => {
    const app = await createServer(t);
    await app.initializeDevices();
    app.readings.power = 500;
    app.controlTick();
    assert.equal((await app.request('/api/data')).json.device_charging.enabled, true);
    await app.assertDevicesOff();
    for (const uri of ['normal', 'advanced']) {
        const forced = await app.request(`/api/device/${uri}/force/test-pass/1`);
        assert.deepEqual(forced.json, {force_mode: true, percent: 1});
    }
    app.controlTick();
    assert.equal((await app.request('/api/device/normal/')).json.toggle, true);
    assert.ok((await app.request('/api/device/advanced/advanced/')).json.alpha < 128);
    app.readings.battery.socPercent = 80;
    await app.request('/api/battery');
    await app.assertDevicesOff();
    app.controlTick();
    await app.assertRequestedPowerOff();
    await app.assertDevicesOff();
    for (const uri of ['normal', 'advanced']) {
        assert.equal((await app.request(`/api/device/${uri}/debug/`)).json.force_mode, true);
    }
});

test('unavailable battery stops previously enabled devices and reports the same decision in both APIs', async (t) => {
    const app = await createServer(t);
    await app.initializeDevices();
    app.controlTick();
    assert.equal((await app.request('/api/device/normal/')).json.toggle, true);
    assert.ok((await app.request('/api/device/advanced/advanced/')).json.alpha < 128);
    app.readings.batteryError = new Error('battery offline');
    const battery = await app.request('/api/battery');
    assert.equal(battery.status, 503);
    assert.deepEqual(battery.json, {error: 'Zendure battery data is unavailable.',
        device_charging: status(false, 'battery-unavailable', null)});
    app.controlTick();
    await app.assertRequestedPowerOff();
    await app.assertDevicesOff();
    assert.deepEqual((await app.request('/api/data')).json.device_charging,
        status(false, 'battery-unavailable', null));
});

test('invalid battery percentages cannot enable devices', async (t) => {
    const app = await createServer(t);
    await app.initializeDevices();
    for (const soc of [undefined, null, '90', NaN, Infinity, -1, 101]) {
        app.readings.battery = {socPercent: soc};
        await app.request('/api/battery');
        assert.deepEqual(JSON.parse(JSON.stringify(app.main.getDeviceChargingStatus())),
            status(false, 'battery-unavailable', null));
        app.controlTick();
        await app.assertDevicesOff();
        await app.assertRequestedPowerOff();
    }
});

test('house power errors disable devices even when the battery is above threshold', async (t) => {
    const app = await createServer(t);
    await app.initializeDevices();
    app.controlTick();
    assert.equal((await app.request('/api/device/normal/')).json.toggle, true);
    app.readings.powerError = new Error('house meter offline');
    const power = await app.request('/api/data');
    assert.equal(power.status, 503);
    assert.deepEqual(power.json, {error: 'Zendure house power data is unavailable.',
        device_charging: status(false, 'power-unavailable', 81)});
    app.controlTick();
    await app.assertDevicesOff();
    app.readings.powerError = null;
    assert.equal((await app.request('/api/data')).json.device_charging.enabled, true);
});

test('expired cached battery readings stop devices until a fresh reading arrives', async (t) => {
    const app = await createServer(t);
    await app.initializeDevices();
    app.controlTick();
    assert.equal((await app.request('/api/device/normal/')).json.toggle, true);
    app.readings.battery.time = Math.floor(Date.now() / 1000) - 60;
    for (let replay = 0; replay < 2; replay++) {
        const battery = await app.request('/api/battery');
        assert.deepEqual(battery.json.device_charging, status(false, 'battery-unavailable', null));
        app.controlTick();
        await app.assertRequestedPowerOff();
        await app.assertDevicesOff();
    }
    app.readings.battery.time = Math.floor(Date.now() / 1000);
    assert.deepEqual((await app.request('/api/battery')).json.device_charging,
        status(true, 'soc-above-threshold', 81));
    app.controlTick();
    assert.equal((await app.request('/api/device/normal/')).json.toggle, true);
});

test('omitting the battery threshold uses 80 percent', async (t) => {
    const app = await createServer(t, {omitMinSoc: true});
    await app.request('/api/data');
    assert.deepEqual((await app.request('/api/battery')).json.device_charging,
        status(true, 'soc-above-threshold', 81));
    app.readings.battery.socPercent = 80;
    assert.deepEqual((await app.request('/api/battery')).json.device_charging,
        status(false, 'soc-at-or-below-threshold', 80));
});

test('invalid battery thresholds fail startup with a configuration error', async (t) => {
    for (const minSoc of [-1, 101, '80', null, NaN, Infinity]) {
        await assert.rejects(createServer(t, {minSoc}),
            /zendure_battery_min_soc must be a number between 0 and 100/);
    }
});

test('battery history API serves queried SOC points and supports CSV export', async (t) => {
    const app = await createServer(t);
    const points = [
        {_time: '2026-10-12T09:00:00.000Z', _value: 79.5},
        {_time: '2026-10-12T09:01:00.000Z', _value: 81}
    ];
    app.batteryHistory.points = points;
    const history = await app.request('/api/data/battery/24h');
    assert.equal(history.status, 200);
    assert.deepEqual(history.json, points);
    assert.deepEqual(app.batteryHistory.queries, ['24h']);

    const csv = await app.request('/api/data/battery/7d?format=csv');
    assert.equal(csv.status, 200);
    assert.match(csv.contentType, /^text\/csv/);
    assert.equal(csv.body,
        '_time,_value\n2026-10-12T09:00:00.000Z,79.5\n2026-10-12T09:01:00.000Z,81');
    assert.deepEqual(app.batteryHistory.queries, ['24h', '7d']);
    assert.deepEqual(app.batteryHistory.csvCalls, [points]);
});

test('battery history rejects invalid periods before querying InfluxDB and reports query errors', async (t) => {
    const app = await createServer(t);
    for (const period of ['invalid', '-1h', '1.5h', '10000h']) {
        const history = await app.request(`/api/data/battery/${period}`);
        assert.equal(history.status, 400);
        assert.match(history.contentType, /^application\/json/);
        assert.match(history.json.error, /Invalid.*period.*parameter/);
    }
    assert.deepEqual(app.batteryHistory.queries, []);
    app.batteryHistory.error = new Error('Battery history query failed');
    const failed = await app.request('/api/data/battery/1h');
    assert.equal(failed.status, 500);
    assert.match(failed.contentType, /^application\/json/);
    assert.deepEqual(failed.json, {error: 'Battery history query failed'});
    assert.deepEqual(app.batteryHistory.queries, ['1h']);
});

test('background battery polling records successful readings independently of house power and device gating', async (t) => {
    const app = await createServer(t, {minSoc: 100});
    app.readings.powerError = new Error('house meter offline');
    const firstBattery = {...app.readings.battery, time: Math.floor(Date.now() / 1000)};
    app.readings.battery = firstBattery;
    app.startBackgroundTasks();
    assert.equal(app.main.getDeviceChargingStatus().enabled, false);
    assert.deepEqual(app.batteryHistory.writes.map(({battery}) => battery), [firstBattery]);

    app.controlTick();
    const secondBattery = {socPercent: 82, state: 'charging', time: firstBattery.time + 20};
    app.readings.battery = secondBattery;
    app.batteryTick();
    assert.deepEqual(app.batteryHistory.writes.map(({battery}) => battery), [firstBattery, secondBattery]);

    app.readings.batteryError = new Error('battery offline');
    app.batteryTick();
    assert.equal(app.batteryHistory.writes.length, 2);

    app.readings.batteryError = null;
    for (const battery of [
        {socPercent: NaN, time: firstBattery.time},
        {socPercent: 101, time: firstBattery.time},
        {socPercent: '82', time: firstBattery.time},
        {socPercent: 82, time: firstBattery.time - 60}
    ]) {
        app.readings.battery = battery;
        app.batteryTick();
        assert.equal(app.batteryHistory.writes.length, 2);
    }
    app.readings.battery = {socPercent: 0, state: 'standby', time: secondBattery.time + 20};
    app.batteryTick();
    assert.equal(app.batteryHistory.writes.length, 3);
    assert.equal(app.batteryHistory.writes[2].battery.socPercent, 0);
});

test('dashboard and battery HTTP requests do not duplicate background battery history', async (t) => {
    const app = await createServer(t);
    await app.request('/api/battery');
    assert.equal((await app.request('/')).status, 200);
    assert.deepEqual(app.batteryHistory.writes, []);

    app.startBackgroundTasks();
    assert.equal(app.batteryHistory.writes.length, 1);
    await app.request('/api/battery');
    await app.request('/');
    app.readings.powerError = new Error('house meter offline');
    assert.equal((await app.request('/')).status, 503);
    assert.equal(app.batteryHistory.writes.length, 1);
});

test('battery history graph routes render the requested period and dashboard entry point', async (t) => {
    const app = await createServer(t);
    for (const period of ['24h', '7d']) {
        const page = await app.request(`/graph/battery/${period}`);
        assert.equal(page.status, 200);
        assert.match(page.contentType, /^text\/html/);
        assert.match(page.body, /\/assets\/battery-graph\.js/);
        assert.match(page.body, new RegExp(`data-period="${period}"`));
        assert.equal(page.body.match(/data-timezone="([^"]*)"/)?.[1],
            requireFromMain('./config.json').timezone);
    }
    const invalid = await app.request('/graph/battery/not-a-period');
    assert.equal(invalid.status, 400);
    assert.match(invalid.body, /Invalid.*period.*parameter/);
    const dashboard = await app.request('/');
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.body, /href="\/graph\/battery\/24h"/);
});
