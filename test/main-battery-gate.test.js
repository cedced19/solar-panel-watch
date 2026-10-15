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

const fullBattery = {socPercent: 100, state: 'standby', chargingPowerW: 0, dischargingPowerW: 0};

// Execute the real server and control loop with no hardware, database, disk writes,
// or running background timers. The callbacks are invoked by each test.
async function createServer(t, {fullSoc = 100, maxChargingPower = 800, omitBatterySettings = false} = {}) {
    const intervals = [];
    const readings = {battery: {...fullBattery}, power: -3000};
    const devices = [
        {uri: 'normal', ids: ['normal-id'], priority: 1, power_limit: 1000,
            power_threshold_percentage: 0.02, time_limit: 2500},
        {uri: 'advanced', ids: ['advanced-id'], priority: 2, power_limit: 1000,
            power_threshold_percentage: 0.02, time_limit: 2500, min_alpha: 40}
    ];
    const config = {...requireFromMain('./config.json'), force_mode_pass: 'test-pass'};
    if (omitBatterySettings) {
        delete config.zendure_battery_full_soc;
        delete config.zendure_battery_max_charging_power;
    } else {
        config.zendure_battery_full_soc = fullSoc;
        config.zendure_battery_max_charging_power = maxChargingPower;
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
    const batteryHistory = {points: [], queries: [], writes: [], csvCalls: [], csvColumns: []};
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
        pointsToCSV(points, columns = ['_time', '_value']) {
            batteryHistory.csvCalls.push(points);
            batteryHistory.csvColumns.push(columns);
            return columns.join(',') + '\n' + points.map((point) =>
                columns.map((column) => point[column] ?? '').join(',')).join('\n');
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

function status(enabled, reason, socPercent, fullSocPercent = 100, maxChargingPowerW = 800) {
    return {enabled, reason, socPercent, fullSocPercent, maxChargingPowerW};
}

async function assertDevicesOn(app) {
    assert.equal((await app.request('/api/device/normal/')).json.toggle, true);
    assert.ok((await app.request('/api/device/advanced/advanced/')).json.alpha < 128);
}

test('battery gating keeps devices off at startup until both readings are known', async (t) => {
    const app = await createServer(t);
    assert.equal(app.main.getDeviceChargingStatus().enabled, false);
    await app.assertDevicesOff();
    const battery = await app.request('/api/battery');
    assert.deepEqual(battery.json.device_charging, status(false, 'power-unavailable', 100));
    await app.assertDevicesOff();
    const power = await app.request('/api/data');
    assert.deepEqual(power.json.device_charging, status(true, 'battery-full', 100));
});

test('devices run only while the battery is full or charging at its maximum power', async (t) => {
    const app = await createServer(t);
    await app.initializeDevices();
    app.controlTick();
    await assertDevicesOn(app);

    const blocked = [
        [{socPercent: 100, state: 'discharging', chargingPowerW: 0, dischargingPowerW: 400}, 'battery-discharging', 100],
        [{socPercent: 60, state: 'charging', chargingPowerW: 300, dischargingPowerW: 0}, 'battery-charging-below-max', 60],
        [{socPercent: 99, state: 'standby', chargingPowerW: 0, dischargingPowerW: 0}, 'battery-not-full', 99]
    ];
    for (const [reading, reason, soc] of blocked) {
        app.readings.battery = reading;
        assert.deepEqual((await app.request('/api/battery')).json.device_charging, status(false, reason, soc));
        app.controlTick();
        await app.assertRequestedPowerOff();
        await app.assertDevicesOff();
    }

    app.readings.battery = {socPercent: 60, state: 'charging', chargingPowerW: 800, dischargingPowerW: 0};
    assert.deepEqual((await app.request('/api/battery')).json.device_charging,
        status(true, 'battery-charging-at-max', 60));
    app.controlTick();
    await assertDevicesOn(app);

    // The battery decision only uses the battery reading: running devices do not
    // count toward its charging power.
    app.readings.battery = {socPercent: 61, state: 'charging', chargingPowerW: 300, dischargingPowerW: 0};
    assert.deepEqual((await app.request('/api/battery')).json.device_charging,
        status(false, 'battery-charging-below-max', 61));
    app.controlTick();
    await app.assertRequestedPowerOff();
    await app.assertDevicesOff();

    app.readings.battery = {...fullBattery};
    await app.request('/api/battery');
    app.controlTick();
    await assertDevicesOn(app);
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
    await assertDevicesOn(app);
    app.readings.battery = {socPercent: 80, state: 'standby', chargingPowerW: 0, dischargingPowerW: 0};
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
    await assertDevicesOn(app);
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
        app.readings.battery = {...fullBattery, socPercent: soc};
        await app.request('/api/battery');
        assert.deepEqual(JSON.parse(JSON.stringify(app.main.getDeviceChargingStatus())),
            status(false, 'battery-unavailable', null));
        app.controlTick();
        await app.assertDevicesOff();
        await app.assertRequestedPowerOff();
    }
});

test('house power errors disable devices even when the battery is full', async (t) => {
    const app = await createServer(t);
    await app.initializeDevices();
    app.controlTick();
    assert.equal((await app.request('/api/device/normal/')).json.toggle, true);
    app.readings.powerError = new Error('house meter offline');
    const power = await app.request('/api/data');
    assert.equal(power.status, 503);
    assert.deepEqual(power.json, {error: 'Zendure house power data is unavailable.',
        device_charging: status(false, 'power-unavailable', 100)});
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
        status(true, 'battery-full', 100));
    app.controlTick();
    assert.equal((await app.request('/api/device/normal/')).json.toggle, true);
});

test('omitting the battery settings requires 100 percent and never treats charging as at max', async (t) => {
    const app = await createServer(t, {omitBatterySettings: true});
    await app.request('/api/data');
    assert.deepEqual((await app.request('/api/battery')).json.device_charging,
        status(true, 'battery-full', 100, 100, null));
    app.readings.battery = {socPercent: 99, state: 'standby'};
    assert.deepEqual((await app.request('/api/battery')).json.device_charging,
        status(false, 'battery-not-full', 99, 100, null));
    app.readings.battery = {socPercent: 99, state: 'charging', chargingPowerW: 5000};
    assert.deepEqual((await app.request('/api/battery')).json.device_charging,
        status(false, 'battery-charging-below-max', 99, 100, null));
});

test('invalid battery settings fail startup with a configuration error', async (t) => {
    for (const fullSoc of [-1, 101, '80', NaN, Infinity]) {
        await assert.rejects(createServer(t, {fullSoc}),
            /zendure_battery_full_soc must be a number between 0 and 100/);
    }
    for (const maxChargingPower of [0, -1, '800', NaN]) {
        await assert.rejects(createServer(t, {maxChargingPower}),
            /zendure_battery_max_charging_power must be a positive number of watts/);
    }
});

test('battery history API serves SOC and power readings together and exports missing fields as blank CSV cells', async (t) => {
    const app = await createServer(t);
    const points = [
        {_time: '2026-10-12T09:00:00.000Z', _value: 79.5,
            outputHomePower: 600, gridInputPower: 0, outputPackPower: 0, packInputPower: 550},
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
        '_time,_value,outputHomePower,gridInputPower,outputPackPower,packInputPower\n' +
        '2026-10-12T09:00:00.000Z,79.5,600,0,0,550\n2026-10-12T09:01:00.000Z,81,,,,');
    assert.deepEqual(app.batteryHistory.queries, ['24h', '7d']);
    assert.deepEqual(app.batteryHistory.csvCalls, [points]);
    assert.deepEqual(app.batteryHistory.csvColumns.map((columns) => Array.from(columns)), [[
        '_time', '_value', 'outputHomePower', 'gridInputPower', 'outputPackPower', 'packInputPower'
    ]]);
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
    const app = await createServer(t);
    app.readings.powerError = new Error('house meter offline');
    const firstBattery = {...app.readings.battery, time: Math.floor(Date.now() / 1000),
        outputHomePowerW: 600, gridInputPowerW: 0, chargingPowerW: 0, dischargingPowerW: 550};
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
