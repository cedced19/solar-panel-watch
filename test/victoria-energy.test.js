const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createRequire} = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Loads lib/victoria-lib.js with a fake client in place of VictoriaMetrics.
function loadLib(client) {
    const filename = path.resolve(__dirname, '../lib/victoria-lib.js');
    const requireFromLib = createRequire(filename);
    const module = {exports: {}};
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, console, setTimeout, clearTimeout,
        require(name) {
            if (name === '../config.json') return {victoria_url: 'http://vm', victoria_default_tag: 'home1'};
            if (name === './victoria-client') return {...requireFromLib(name), createVictoriaClient: () => client};
            return requireFromLib(name);
        }
    }, {filename});
    return module.exports;
}

const hour = 3600 * 1000;
// Objects made in the sandbox have its prototypes: compare their plain copies.
const plain = value => JSON.parse(JSON.stringify(value));

// A client exporting the given samples as the metric it is asked for,
// recording the calls.
function exporting(timestamps, values) {
    const calls = [];
    return {
        calls,
        async exportSeries(selectors, start, stop, onSeries) {
            calls.push({selectors, start, stop});
            const name = /__name__="([^"]+)"/.exec(selectors)[1];
            if (timestamps.length) onSeries({metric: {__name__: name, home: 'home1'}, timestamps, values});
        }
    };
}

test('every query rejects VictoriaMetrics errors instead of crashing', async () => {
    const failure = new Error('VictoriaMetrics unavailable');
    const lib = loadLib({
        exportSeries: () => Promise.reject(failure),
        queryWindows: () => Promise.reject(failure)
    });
    for (const request of [
        () => lib.requestPowerOverPeriodMulti('24h', ['power1', 'power2']),
        () => lib.requestPowerOverRange('2026-10-13', '2026-10-14', ['power1', 'power2']),
        () => lib.requestPowerIntegralOverPeriod('3h', 'heater'),
        () => lib.requestPowerOverPeriodGraph('1d', 'power1'),
        () => lib.requestPowerOverPeriodGroupBy('1d', 'power1', '5m'),
        () => lib.requestLastVar('heater'),
        () => lib.requestConsumptionOverPeriod('1d', '30m'),
        () => lib.streamConsumptionOverRange(new Date(0), new Date(hour), {})
    ]) {
        await assert.rejects(request(), error => error === failure);
    }
    const done = await new Promise(resolve => lib.streamPowerOverPeriod('1h', 'heater', () => {}, resolve));
    assert.equal(done, failure);
});

test('the energy of a device is the trapezoidal integral of its points, in Wh, like Influx integral()', async () => {
    const client = exporting([0, hour, 2 * hour], [0, 1000, 1000]);
    assert.equal(await loadLib(client).requestPowerIntegralOverPeriod('3h', 'heater'), 1500);
    assert.equal(client.calls[0].selectors, '{__name__="power_heater",home="home1"}');
    assert.equal(client.calls[0].stop - client.calls[0].start, 3 * hour);
    assert.equal(await loadLib(exporting([hour], [500])).requestPowerIntegralOverPeriod('3h', 'heater'), 0);
    assert.equal(await loadLib(exporting([], [])).requestPowerIntegralOverPeriod('3h', 'heater'), null);
});

test('raw series, streams and last values come from the export', async () => {
    const lib = loadLib(exporting([1000, 2000], [5, -7]));
    assert.deepEqual(plain(await lib.requestPowerOverPeriod('1h', 'heater')), [
        {_time: '1970-01-01T00:00:01.000Z', _value: 5}, {_time: '1970-01-01T00:00:02.000Z', _value: -7}
    ]);
    const streamed = [];
    await new Promise(resolve => lib.streamPowerOverPeriod('1h', 'heater', (t, v) => streamed.push([t, v]), resolve));
    assert.deepEqual(streamed, [[1000, 5], [2000, -7]]);
    assert.deepEqual(plain(await lib.requestLastVar('heater')), [{_time: '1970-01-01T00:00:02.000Z', _value: -7}]);
    assert.deepEqual(plain(await loadLib(exporting([], [])).requestLastPower('heater')), []);
});

test('graphs average windows chosen from the period, short periods and raw requests stay raw', async () => {
    const queries = [];
    const client = {
        ...exporting([1000], [1]),
        async queryWindows(query, start, stop, step) {
            queries.push({query, start, stop, step});
            return [{metric: {}, timestamps: [30 * 60000, 60 * 60000], values: [10, 20]}];
        }
    };
    const lib = loadLib(client);
    assert.deepEqual(plain(await lib.requestPowerOverPeriodGraph('1d', 'power1')), [
        {_time: '1970-01-01T00:30:00.000Z', _value: 10}, {_time: '1970-01-01T01:00:00.000Z', _value: 20}
    ]);
    assert.deepEqual(queries.map(({query, step}) => [query, step]),
        [['avg_over_time({__name__="power_power1",home="home1"}[1800000ms])', 30 * 60000]]);
    await lib.requestPowerOverPeriodGroupBy('1w', 'power2', '15m');
    assert.equal(queries[1].step, 15 * 60000);
    assert.equal(queries[1].stop - queries[1].start, 7 * 24 * hour);
    assert.deepEqual(plain(await lib.requestPowerOverPeriodGraph('30m', 'power1')), [{_time: '1970-01-01T00:00:01.000Z', _value: 1}]);
    assert.equal(queries.length, 2);
    assert.deepEqual(plain(await loadLib({queryWindows: async () => []}).requestPowerOverPeriodGraph('1d', 'x', '5m')), []);
});

test('device power and control variables are queued with the home and sent on flush', async () => {
    const batches = [];
    const lib = loadLib({async write(lines) { batches.push(lines); }});
    const before = Date.now();
    lib.writePower(false, 'chauffe-eau', 2000);
    lib.writeVar(false, 'chauffe-eau', 54.5);
    lib.writeVar(false, 'chauffe-eau', NaN);
    await lib.flushWrites();
    assert.equal(batches.length, 1);
    const [power, variable] = batches[0];
    assert.match(power, /^power,home=home1 chauffe-eau=2000 \d+$/);
    assert.match(variable, /^var,home=home1 chauffe-eau=54.5 \d+$/);
    assert.ok(Number(power.split(' ')[2]) >= before);
    assert.equal(batches[0].length, 2, 'a value that is not a number is not written');
});
