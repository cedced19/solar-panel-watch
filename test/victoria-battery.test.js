const assert = require('node:assert/strict');
const test = require('node:test');
const {createBatteryHistory} = require('../lib/victoria-lib');

const config = {victoria_default_tag: 'test-home'};

function writer() {
    const lines = [];
    const logs = [];
    const api = createBatteryHistory({
        config,
        now: () => 1780000000123,
        writes: {write(line) { lines.push(line); }},
        log(message) { logs.push(message); }
    });
    return {api, lines, logs};
}

test('battery history stores SOC and all four powers in one line with the reading timestamp and home', async () => {
    const {api, lines, logs} = writer();
    const reading = {socPercent: 83.5, time: 1770000123, outputHomePowerW: 330,
        gridInputPowerW: 10, chargingPowerW: 220, dischargingPowerW: 40};
    await api.writeBatteryLevel(true, reading);
    // A cached poll writes the same point instead of inventing a new reading time.
    await api.writeBatteryLevel(false, reading);
    assert.deepEqual(lines, [
        'battery,home=test-home socPercent=83.5,outputHomePower=330,gridInputPower=10,outputPackPower=220,packInputPower=40 1770000123000',
        'battery,home=test-home socPercent=83.5,outputHomePower=330,gridInputPower=10,outputPackPower=220,packInputPower=40 1770000123000'
    ]);
    assert.deepEqual(logs, ['Battery level queued for VictoriaMetrics.']);
});

test('battery power history preserves zero and omits missing or invalid optional readings', async () => {
    const {api, lines} = writer();
    await api.writeBatteryLevel(false, {socPercent: 50, time: 1770000123, outputHomePowerW: 0,
        gridInputPowerW: 0, chargingPowerW: 0, dischargingPowerW: 0});
    assert.equal(lines[0],
        'battery,home=test-home socPercent=50,outputHomePower=0,gridInputPower=0,outputPackPower=0,packInputPower=0 1770000123000');

    const invalidValues = [undefined, null, '100', false, NaN, Infinity, -Infinity, -1];
    for (const invalid of invalidValues) {
        await api.writeBatteryLevel(false, {socPercent: 50, time: 1770000123, outputHomePowerW: invalid,
            gridInputPowerW: invalid, chargingPowerW: invalid, dischargingPowerW: invalid});
    }
    assert.equal(lines.length, invalidValues.length + 1);
    assert.ok(lines.slice(1).every((line) => line === 'battery,home=test-home socPercent=50 1770000123000'));
});

test('zero percent is a valid reading, and absent timestamps alone use the local time', async () => {
    const {api, lines} = writer();
    await api.writeBatteryLevel(false, {socPercent: 0, time: 0});
    await api.writeBatteryLevel(false, {socPercent: 100});
    assert.deepEqual(lines, ['battery,home=test-home socPercent=0 0', 'battery,home=test-home socPercent=100 1780000000123']);
});

test('unavailable or invalid levels and supplied invalid timestamps create no battery history', async () => {
    const {api, lines} = writer();
    for (const battery of [null, undefined, {}, {socPercent: null}, {socPercent: '80'},
        {socPercent: NaN}, {socPercent: Infinity}, {socPercent: -1}, {socPercent: 100.1},
        {socPercent: 80, time: '1770000123'}, {socPercent: 80, time: NaN},
        {socPercent: 80, time: Infinity}, {socPercent: 80, time: Number.MAX_VALUE}]) {
        await api.writeBatteryLevel(false, battery);
    }
    assert.deepEqual(lines, []);
});

// Exported series as VictoriaMetrics sends them: one line per series (or part of one).
function history(series, calls = []) {
    return createBatteryHistory({
        config,
        client: {
            async exportSeries(selectors, start, stop, onSeries) {
                calls.push({selectors, start, stop});
                series.forEach(onSeries);
            }
        }
    });
}

const metric = field => ({__name__: 'battery_' + field, home: 'test-home'});
const at = seconds => Date.UTC(2026, 9, 12, 10, 0, seconds);
const iso = seconds => new Date(at(seconds)).toISOString();

test('battery query selects this home and all five fields in one export, merges them by time and sorts history', async () => {
    const calls = [];
    const api = history([
        {metric: metric('outputHomePower'), timestamps: [at(20), at(40)], values: [250, 100]},
        {metric: metric('socPercent'), timestamps: [at(0), at(20)], values: [0, 1]},
        {metric: metric('gridInputPower'), timestamps: [at(20)], values: [0]},
        {metric: metric('outputPackPower'), timestamps: [at(20)], values: [80]},
        {metric: metric('packInputPower'), timestamps: [at(20)], values: [0]}
    ], calls);
    const before = Date.now();
    const points = await api.requestBatteryLevelOverPeriod('24h');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].selectors, '{' + ['socPercent', 'outputHomePower', 'gridInputPower', 'outputPackPower', 'packInputPower']
        .map(field => `__name__="battery_${field}",home="test-home"`).join(' or ') + '}');
    assert.ok(calls[0].stop >= before && calls[0].stop <= Date.now());
    assert.equal(calls[0].stop - calls[0].start, 24 * 3600 * 1000);
    assert.deepEqual(points, [
        {_time: iso(0), _value: 0},
        {_time: iso(20), _value: 1, outputHomePower: 250, gridInputPower: 0, outputPackPower: 80, packInputPower: 0},
        // A row without SOC keeps the time, with an unavailable level.
        {_time: iso(40), _value: null, outputHomePower: 100}
    ]);
});

test('battery history remains compatible with SOC-only history without any power series', async () => {
    const api = history([{metric: metric('socPercent'), timestamps: [at(0), at(20)], values: [80, 0]}]);
    assert.deepEqual(await api.requestBatteryLevelOverPeriod('1h'), [
        {_time: iso(0), _value: 80},
        {_time: iso(20), _value: 0}
    ]);
});

test('battery query rejects VictoriaMetrics errors instead of returning partial history', async () => {
    const failure = new Error('VictoriaMetrics query failed');
    const api = createBatteryHistory({
        config,
        client: {
            async exportSeries(selectors, start, stop, onSeries) {
                onSeries({metric: metric('socPercent'), timestamps: [at(0)], values: [80]});
                throw failure;
            }
        }
    });
    await assert.rejects(api.requestBatteryLevelOverPeriod('1h'), (error) => error === failure);
});
