const assert = require('node:assert/strict');
const test = require('node:test');
const computeConsumptionPower = require('../lib/compute-consumption-power');

const at = seconds => new Date(Date.UTC(2026, 9, 13, 10, 0, seconds)).toISOString();
const point = (seconds, value) => ({_time: at(seconds), _value: value});
const battery = (seconds, discharging, charging) => ({
    _time: at(seconds), packInputPower: discharging, outputPackPower: charging
});

test('raw total aligns preceding readings by time, adds discharge, subtracts charge and preserves export', () => {
    const data = {
        power1: [point(30, -200), point(10, 500), point(20, 100)],
        power2: [point(10, 1000), point(30, 600)],
        battery: [battery(5, 300, 0), battery(25, 0, 200)]
    };
    const result = computeConsumptionPower(data);
    assert.deepEqual(result.house_consumption, [point(10, 1800), point(20, 1400), point(30, 200)]);
    assert.deepEqual(result.battery_charging, [point(5, 0), point(25, 200)]);
});

test('raw total never uses future, stale or missing pack and solar readings', () => {
    const data = {power1: [point(0, 500), point(10, 500), point(40, 500)],
        power2: [point(0, 1000)], battery: [battery(5, 300, 0)]};
    assert.deepEqual(computeConsumptionPower(data).house_consumption,
        [point(0, null), point(10, 1800), point(40, null)]);
    data.power2.push(point(40, 1000));
    assert.equal(computeConsumptionPower(data).house_consumption[2]._value, null);
    data.battery.push({_time: at(40), _value: 80});
    const result = computeConsumptionPower(data);
    assert.equal(result.house_consumption[2]._value, null);
    assert.equal(result.battery_discharging[1]._value, null);
    assert.equal(result.battery_charging[1]._value, null);
});

test('aggregate total joins only matching windows, regardless of missing indices', () => {
    const result = computeConsumptionPower({
        power1: [point(0, 500), point(60, 400), point(120, 300)],
        power2: [point(0, 1000), point(120, 800)],
        battery: [battery(0, 300, 0), battery(60, 0, 200), battery(120, 0, 0)]
    }, {aggregated: true});
    assert.deepEqual(result.house_consumption, [point(0, 1800), point(60, null), point(120, 1100)]);
});

test('zero is available while negative or nonnumeric pack power produces gaps', () => {
    for (const value of [null, undefined, NaN, Infinity, -1, '0']) {
        const result = computeConsumptionPower({power1: [point(0, 500)], power2: [point(0, 0)],
            battery: [battery(0, value, 0)]});
        assert.equal(result.house_consumption[0]._value, null);
    }
    assert.equal(computeConsumptionPower({power1: [point(0, 500)], power2: [point(0, 0)],
        battery: [battery(0, 0, 0)]}).house_consumption[0]._value, 500);
});
