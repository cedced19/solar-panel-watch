const assert = require('node:assert/strict');
const test = require('node:test');
const computeEnergy = require('../lib/compute-energy');

function points(values, day = 13) {
    return values.map((value, i) => ({
        _time: new Date(2026, 9, day, 12, i).toISOString(), _value: value
    }));
}

test('aligned readings preserve grid import/export, solar, house and the 15-second tail', () => {
    const network = points([600, -300, 1200]);
    assert.deepEqual(computeEnergy(network, points([1200, 1800, 2400])), [{
        start_date: new Date(network[0]._time), end_date: new Date(network[2]._time),
        consumption_on_network: 0.015, introduced_on_network: -0.005,
        solar_panel: 0.06, house_consumption: 0.07
    }]);
});

test('empty or omitted solar readings retain network totals and mark dependent totals unavailable', () => {
    const network = points([600, -300, 1200]);
    for (const solar of [[], undefined]) {
        const [day] = computeEnergy(network, solar);
        assert.equal(day.consumption_on_network, 0.015);
        assert.equal(day.introduced_on_network, -0.005);
        assert.equal(day.solar_panel, null);
        assert.equal(day.house_consumption, null);
    }
    assert.deepEqual(computeEnergy([], points([600])), []);
});

test('solar gaps at the start, middle or end retain independently integrated totals', () => {
    const network = points([600, -300, 1200]);
    const solar = points([1200, 1800, 2400]);
    const expectedSolar = [0.04, 0.05, 0.027];
    const expectedHouse = [0.05, 0.06, 0.037];
    for (let missing = 0; missing < solar.length; missing++) {
        const [day] = computeEnergy(network, solar.filter((_, i) => i !== missing));
        assert.equal(day.consumption_on_network, 0.015);
        assert.equal(day.introduced_on_network, -0.005);
        assert.equal(day.solar_panel, expectedSolar[missing]);
        assert.equal(day.house_consumption, expectedHouse[missing]);
    }
});

test('solar energy uses its own timestamps when equal-length series are offset', () => {
    const solar = points([1200, 1800, 2400]);
    solar[1]._time = new Date(Date.parse(solar[1]._time) + 1000).toISOString();
    const [day] = computeEnergy(points([600, -300, 1200]), solar);
    assert.equal(day.solar_panel, 0.059);
    assert.equal(day.house_consumption, 0.069);
});

test('extra solar timestamps contribute to solar energy and measured zero remains zero', () => {
    const network = points([600, 600]);
    const solar = points([0, 0]);
    solar.unshift({_time: new Date(Date.parse(solar[0]._time) - 1000).toISOString(), _value: 500});
    const [day] = computeEnergy(network, solar);
    assert.equal(day.solar_panel, 0);
    assert.equal(day.house_consumption, 0.012);
    solar[0]._value = 3600;
    assert.equal(computeEnergy(network, solar)[0].solar_panel, 0.001);
});

test('incomplete solar on one day does not invalidate the next day', () => {
    const first = points([600, 600]);
    const second = points([600, 600], 14);
    const result = computeEnergy([...first, ...second], points([1200, 1200], 14));
    assert.equal(result.length, 2);
    assert.equal(result[0].solar_panel, null);
    assert.equal(result[1].solar_panel, 0.025);
    assert.equal(result[1].house_consumption, 0.037);
});

test('non-finite or null solar readings are unavailable', () => {
    for (const value of [null, NaN, Infinity]) {
        const [day] = computeEnergy(points([600]), points([value]));
        assert.equal(day.solar_panel, null);
        assert.equal(day.house_consumption, null);
    }
});

test('local-midnight samples preserve the inclusive boundary and daily tails', () => {
    const network = [
        {_time: new Date(2026, 9, 13, 23, 59).toISOString(), _value: 600},
        {_time: new Date(2026, 9, 14).toISOString(), _value: 1200}
    ];
    const solar = network.map(point => ({...point, _value: 600}));
    const result = computeEnergy(network, solar);
    assert.equal(result.length, 2);
    assert.equal(result[0].consumption_on_network, 0.015);
    assert.equal(result[0].solar_panel, 0.012);
    assert.equal(result[1].consumption_on_network, 0.005);
    assert.equal(result[1].solar_panel, 0.002);

    const missingBoundary = computeEnergy(network, solar.slice(0, 1));
    assert.equal(missingBoundary[0].solar_panel, 0.002);
    assert.equal(missingBoundary[1].solar_panel, null);
});

test('invalid readings do not discard usable solar samples', () => {
    const solar = points([1200, null, 2400]);
    const [day] = computeEnergy(points([600, -300, 1200]), solar);
    assert.equal(day.solar_panel, 0.05);
    assert.equal(day.house_consumption, 0.06);
});
