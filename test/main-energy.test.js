const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const {createRequire} = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('calendar and period energy endpoints handle missing solar and save usable results', async (t) => {
    const mainPath = path.resolve(__dirname, '../main.js');
    const requireFromMain = createRequire(mainPath);
    const history = [];
    const queries = [];
    let data = {power1: [
        {_time: new Date(2026, 9, 13, 12).toISOString(), _value: 600},
        {_time: new Date(2026, 9, 13, 12, 1).toISOString(), _value: 600}
    ], power2: []};
    const influx = {
        async requestPowerOverRange(start, stop, tags) {
            queries.push({start, stop, tags});
            return data;
        },
        async requestPowerOverPeriodMulti() { return data; }
    };
    const database = {
        post(entry, cb) { history.push(entry); cb(null); },
        save(cb) { cb(); },
        getAll() { return history; }
    };
    const module = {exports: {}};
    vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), {
        module, exports: module.exports, __dirname: path.dirname(mainPath), process, console,
        require(name) {
            if (name === './lib/influx-lib.js') return influx;
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

    function request(route) {
        return new Promise((resolve, reject) => {
            http.get({host: '127.0.0.1', port: server.address().port, path: route}, res => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => resolve({status: res.statusCode, body}));
            }).on('error', reject);
        });
    }

    const calendar = await request('/api/data/energy/day/2026-10-13');
    assert.equal(calendar.status, 200);
    const [day] = JSON.parse(calendar.body);
    assert.equal(day.consumption_on_network, 0.012);
    assert.equal(day.introduced_on_network, 0);
    assert.equal(day.solar_panel, null);
    assert.equal(day.house_consumption, null);
    assert.equal(queries[0].start.getTime(), new Date(2026, 9, 13).getTime());
    assert.equal(queries[0].stop.getTime(), new Date(2026, 9, 14).getTime());
    assert.deepEqual(Array.from(queries[0].tags), ['power1', 'power2']);
    assert.equal(history[0].period, '2026-10-13');
    assert.deepEqual(JSON.parse(JSON.stringify(history[0].result)), [day]);

    const period = await request('/api/data/energy/24h');
    assert.equal(period.status, 200);
    assert.deepEqual(JSON.parse(period.body), [day]);
    const coverage = await request('/api/data/energy-calendar/');
    assert.deepEqual(JSON.parse(coverage.body), ['2026-10-13']);

    data.power2 = [{...data.power1[1], _value: 1200}];
    const sparseSolar = await request('/api/data/energy/day/2026-10-13');
    assert.equal(sparseSolar.status, 200);
    const [sparseDay] = JSON.parse(sparseSolar.body);
    assert.equal(sparseDay.consumption_on_network, 0.012);
    assert.equal(sparseDay.solar_panel, 0.005);
    assert.equal(sparseDay.house_consumption, 0.017);
    const sparsePeriod = await request('/api/data/energy/24h');
    assert.deepEqual(JSON.parse(sparsePeriod.body), [sparseDay]);

    data = {power1: [], power2: []};
    const empty = await request('/api/data/energy/day/2026-10-14');
    assert.equal(empty.status, 200);
    assert.deepEqual(JSON.parse(empty.body), []);

    const page = await request('/energy-calendar/');
    assert.equal(page.status, 200);
    for (const script of page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        new vm.Script(script[1]);
    }
});
