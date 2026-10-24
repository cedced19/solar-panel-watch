const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const {createRequire} = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('energy day endpoints compute missing days once, store them and recompute on demand', async (t) => {
    const mainPath = path.resolve(__dirname, '../main.js');
    const requireFromMain = createRequire(mainPath);
    const {createEnergyDayStore} = require('../lib/energy-day-store.js');
    const store = createEnergyDayStore(':memory:');
    const queries = [];
    let data = {power1: [
        {_time: new Date(2026, 9, 13, 12).toISOString(), _value: 600},
        {_time: new Date(2026, 9, 13, 12, 1).toISOString(), _value: 600}
    ], power2: [], battery: []};
    let failure;
    const influx = {
        async requestConsumptionOverRange(start, stop) {
            queries.push({start, stop});
            if (failure) throw failure;
            return data;
        },
        async requestConsumptionOverPeriod(period, every) {
            queries.push({period, every});
            if (failure) throw failure;
            return data;
        },
        getAggregateWindow() { return '30m'; }
    };
    const database = {
        post(entry, cb) { cb(null); },
        save(cb) { cb(); },
        getAll() { return []; }
    };
    const module = {exports: {}};
    vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), {
        module, exports: module.exports, __dirname: path.dirname(mainPath), process, console,
        require(name) {
            if (name === './lib/influx-lib.js') return influx;
            if (name === './lib/energy-day-store.js') return {createEnergyDayStore: () => store};
            if (name === 'json-store-list') return () => database;
            if (name === 'morgan') return () => (_req, _res, next) => next();
            if (name === 'fs') return {...fs, existsSync: () => true};
            return requireFromMain(name);
        }
    }, {filename: mainPath});
    const server = await new Promise(resolve => {
        const listener = module.exports.app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));

    function request(route, method = 'GET') {
        return new Promise((resolve, reject) => {
            http.request({host: '127.0.0.1', port: server.address().port, path: route, method}, res => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body}));
            }).on('error', reject).end();
        });
    }

    const recompute = route => request(route + '/recompute', 'POST');

    const calendar = await request('/api/data/energy/day/2026-10-13');
    assert.equal(calendar.status, 200);
    const day = JSON.parse(calendar.body);
    assert.equal(day.day, '2026-10-13');
    assert.equal(day.consumption_on_network, 0.012);
    assert.equal(day.introduced_on_network, 0);
    assert.equal(day.solar_panel, null);
    assert.equal(day.house_consumption, null);
    assert.equal(day.battery_discharging, null);
    assert.equal(day.battery_charging, null);
    assert.equal(day.complete, true);
    assert.equal(day.source, 'influx');
    assert.equal(queries[0].start.getTime(), new Date(2026, 9, 13).getTime());
    assert.equal(queries[0].stop.getTime(), new Date(2026, 9, 14).getTime());
    assert.deepEqual(store.get('2026-10-13'), day);

    // A complete stored day is served without querying Influx again.
    const stored = await request('/api/data/energy/day/2026-10-13');
    assert.deepEqual(JSON.parse(stored.body), day);
    assert.equal(queries.length, 1);
    const coverage = await request('/api/data/energy-calendar/');
    assert.deepEqual(JSON.parse(coverage.body), [{day: '2026-10-13', complete: true, has_data: true}]);
    const range = JSON.parse((await request('/api/data/energy/days?start=2026-10-12&end=2026-10-14')).body);
    assert.deepEqual(range, {days: [day], stale: ['2026-10-12', '2026-10-14']});
    const all = JSON.parse((await request('/api/data/energy/days?end=2026-10-13')).body);
    assert.deepEqual(all, {days: [day], stale: []});

    data.power2 = [{...data.power1[1], _value: 1200}];
    data.battery = data.power1.map(point => ({_time: point._time, packInputPower: 0, outputPackPower: 0}));
    const sparseSolar = await recompute('/api/data/energy/day/2026-10-13');
    assert.equal(sparseSolar.status, 200);
    const sparseDay = JSON.parse(sparseSolar.body);
    assert.equal(sparseDay.consumption_on_network, 0.012);
    assert.equal(sparseDay.solar_panel, 0.005);
    assert.equal(sparseDay.house_consumption, 0.017);
    assert.equal(queries.length, 2);

    data.power2 = data.power1.map(point => ({...point, _value: 1200}));
    for (const battery of [[], data.power1.map(point => ({_time: point._time, _value: 80})),
        data.power1.map(point => ({_time: point._time, packInputPower: 600}))]) {
        data.battery = battery;
        const response = await recompute('/api/data/energy/day/2026-10-13');
        assert.equal(response.status, 200);
        const fallbackDay = JSON.parse(response.body);
        assert.equal(fallbackDay.house_consumption, 0.037);
        assert.equal(fallbackDay.battery_charging, null);
        assert.equal(store.get('2026-10-13').house_consumption, 0.037);
        const balance = await request('/api/data/consumption/24h?raw=true');
        assert.equal(balance.status, 200);
        assert.deepEqual(JSON.parse(balance.body).house_consumption.map(point => point._value), [1800, 1800]);
    }
    data.battery = data.power1.map(point => ({_time: point._time, packInputPower: 600, outputPackPower: 300}));
    const chargedDay = JSON.parse((await recompute('/api/data/energy/day/2026-10-13')).body);
    assert.equal(chargedDay.battery_discharging, 0.012);
    assert.equal(chargedDay.battery_charging, 0.006);
    assert.equal(chargedDay.house_consumption, 0.043);
    assert.equal(queries.at(-1).every, undefined); // energy always integrates raw points
    assert.equal(store.get('2026-10-13').battery_charging, 0.006);

    for (const [suffix, expectedEvery] of [['?every=1m', '1m'], ['?raw=true&every=1h', null], ['', '30m']]) {
        const balance = await request('/api/data/consumption/24h' + suffix);
        assert.equal(balance.status, 200);
        assert.equal(queries.at(-1).every, expectedEvery);
        assert.deepEqual(JSON.parse(balance.body).house_consumption.map(point => point._value), [2100, 2100]);
    }
    assert.equal((await request('/api/data/consumption/invalid')).status, 400);
    failure = new Error('Influx unavailable');
    const failed = await request('/api/data/consumption/24h');
    assert.equal(failed.status, 500);
    assert.deepEqual(JSON.parse(failed.body), {error: 'Influx unavailable'});
    assert.equal((await request('/api/data/energy/day/2026-10-14')).status, 500);
    assert.equal(store.get('2026-10-14'), null, 'a failed query stores nothing');
    failure = null;

    // A day without readings is stored, so it is not queried again; it never
    // replaces figures already stored for that day.
    data = {power1: [], power2: [], battery: []};
    const empty = JSON.parse((await request('/api/data/energy/day/2026-10-14')).body);
    assert.equal(empty.start_date, null);
    assert.equal(empty.consumption_on_network, null);
    assert.equal(empty.complete, true);
    const kept = JSON.parse((await recompute('/api/data/energy/day/2026-10-13')).body);
    assert.equal(kept.house_consumption, 0.043);
    assert.deepEqual(JSON.parse((await request('/api/data/energy-calendar/')).body),
        [{day: '2026-10-13', complete: true, has_data: true}, {day: '2026-10-14', complete: true, has_data: false}]);

    for (const route of ['/api/data/energy/day/2026-13-01', '/api/data/energy/day/2026-02-30',
        '/api/data/energy/day/2999-01-01', '/api/data/energy/days?start=yesterday']) {
        assert.equal((await request(route)).status, 400, route);
    }
    for (const route of ['/api/data/energy/24h', '/api/data/energy-request-hist/', '/energy-hist/', '/energy/24h']) {
        assert.equal((await request(route)).status, 404, route);
    }
    const redirect = await request('/energy/3d');
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, '/energy-graph/#duration=3');

    for (const route of ['/energy-calendar/', '/energy/current-day', '/energy-graph/']) {
        const page = await request(route);
        assert.equal(page.status, 200, route);
        for (const script of page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
            new vm.Script(script[1]);
        }
    }
});
