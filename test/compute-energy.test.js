const assert = require('node:assert/strict');
const test = require('node:test');
const computeEnergy = require('../lib/compute-energy');

function points(values, day = 13) {
    return values.map((value, i) => ({
        _time: new Date(2026, 9, day, 12, i).toISOString(), _value: value
    }));
}

function batteryPoints(dischargingValues, chargingValues = dischargingValues.map(() => 0), day = 13) {
    return points(dischargingValues, day).map((point, i) => ({
        _time: point._time, _value: 50,
        packInputPower: point._value, outputPackPower: chargingValues[i]
    }));
}

test('aligned readings preserve grid import/export, solar, house and the 15-second tail', () => {
    const network = points([600, -300, 1200]);
    assert.deepEqual(computeEnergy(network, points([1200, 1800, 2400]), batteryPoints([0, 0, 0])), [{
        start_date: new Date(network[0]._time), end_date: new Date(network[2]._time),
        consumption_on_network: 0.015, introduced_on_network: -0.005,
        solar_panel: 0.06, battery_discharging: 0, battery_charging: 0,
        house_consumption: 0.07
    }]);
});

test('empty or omitted solar readings retain network totals and mark dependent totals unavailable', () => {
    const network = points([600, -300, 1200]);
    for (const solar of [[], undefined]) {
        const [day] = computeEnergy(network, solar, batteryPoints([0, 0, 0]));
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
        const [day] = computeEnergy(network, solar.filter((_, i) => i !== missing), batteryPoints([0, 0, 0]));
        assert.equal(day.consumption_on_network, 0.015);
        assert.equal(day.introduced_on_network, -0.005);
        assert.equal(day.solar_panel, expectedSolar[missing]);
        assert.equal(day.house_consumption, expectedHouse[missing]);
    }
});

test('solar energy uses its own timestamps when equal-length series are offset', () => {
    const solar = points([1200, 1800, 2400]);
    solar[1]._time = new Date(Date.parse(solar[1]._time) + 1000).toISOString();
    const [day] = computeEnergy(points([600, -300, 1200]), solar, batteryPoints([0, 0, 0]));
    assert.equal(day.solar_panel, 0.059);
    assert.equal(day.house_consumption, 0.069);
});

test('extra solar timestamps contribute to solar energy and measured zero remains zero', () => {
    const network = points([600, 600]);
    const solar = points([0, 0]);
    solar.unshift({_time: new Date(Date.parse(solar[0]._time) - 1000).toISOString(), _value: 500});
    const [day] = computeEnergy(network, solar, batteryPoints([0, 0]));
    assert.equal(day.solar_panel, 0);
    assert.equal(day.house_consumption, 0.012);
    solar[0]._value = 3600;
    assert.equal(computeEnergy(network, solar, batteryPoints([0, 0]))[0].solar_panel, 0.001);
});

test('incomplete solar on one day does not invalidate the next day', () => {
    const first = points([600, 600]);
    const second = points([600, 600], 14);
    const result = computeEnergy([...first, ...second], points([1200, 1200], 14), [
        ...batteryPoints([0, 0]), ...batteryPoints([0, 0], undefined, 14)
    ]);
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
    const [day] = computeEnergy(points([600, -300, 1200]), solar, batteryPoints([0, 0, 0]));
    assert.equal(day.solar_panel, 0.05);
    assert.equal(day.house_consumption, 0.06);
});

test('battery discharge increases household energy and charging subtracts from it', () => {
    const [day] = computeEnergy(points([600, -300, 1200]), points([1200, 1800, 2400]),
        batteryPoints([600, 1200, 1800], [300, 600, 900]));
    assert.equal(day.consumption_on_network, 0.015);
    assert.equal(day.introduced_on_network, -0.005);
    assert.equal(day.solar_panel, 0.06);
    assert.equal(day.battery_discharging, 0.037);
    assert.equal(day.battery_charging, 0.018);
    assert.equal(day.house_consumption, 0.088);
});

test('battery energy uses its own unequal timestamps and includes extra samples', () => {
    const battery = batteryPoints([600, 1200, 1800], [300, 600, 900]);
    battery[1]._time = new Date(Date.parse(battery[1]._time) + 10000).toISOString();
    battery.unshift({
        _time: new Date(Date.parse(battery[0]._time) - 5000).toISOString(),
        packInputPower: 3600, outputPackPower: 1800
    });
    const [day] = computeEnergy(points([600, -300, 1200]), points([1200, 1800, 2400]), battery);
    assert.equal(day.battery_discharging, 0.04);
    assert.equal(day.battery_charging, 0.02);
    assert.equal(day.house_consumption, 0.09);
});

test('omitted, empty and older SOC-only battery history make battery totals unavailable', () => {
    for (const battery of [undefined, [], points([50, 49, 48])]) {
        const [day] = computeEnergy(points([600, -300, 1200]), points([1200, 1800, 2400]), battery);
        assert.equal(day.consumption_on_network, 0.015);
        assert.equal(day.introduced_on_network, -0.005);
        assert.equal(day.solar_panel, 0.06);
        assert.equal(day.battery_discharging, null);
        assert.equal(day.battery_charging, null);
        assert.equal(day.house_consumption, null);
    }
});

test('partially missing battery fields invalidate their direction and household totals for that day', () => {
    const battery = batteryPoints([600, 1200, 1800], [300, 600, 900]);
    delete battery[1].outputPackPower;
    const [day] = computeEnergy(points([600, -300, 1200]), points([1200, 1800, 2400]), battery);
    assert.equal(day.battery_discharging, 0.037);
    assert.equal(day.battery_charging, null);
    assert.equal(day.house_consumption, null);
});

test('invalid battery power remains unavailable while a measured zero remains zero', () => {
    for (const value of [null, NaN, Infinity, -1]) {
        const battery = batteryPoints([0, 0]);
        battery[1].packInputPower = value;
        const [day] = computeEnergy(points([600, 600]), points([0, 0]), battery);
        assert.equal(day.battery_discharging, null);
        assert.equal(day.battery_charging, 0);
        assert.equal(day.house_consumption, null);
    }
    const [day] = computeEnergy(points([600, 600]), points([0, 0]), batteryPoints([0, 0]));
    assert.equal(day.battery_discharging, 0);
    assert.equal(day.battery_charging, 0);
    assert.equal(day.house_consumption, 0.012);
});

test('SOC-only history on one day does not invalidate complete battery history on the next day', () => {
    const [first, second] = computeEnergy(
        [...points([600, 600]), ...points([600, 600], 14)],
        [...points([1200, 1200]), ...points([1200, 1200], 14)],
        [...points([50, 49]), ...batteryPoints([600, 600], [300, 300], 14)]
    );
    assert.equal(first.battery_discharging, null);
    assert.equal(first.battery_charging, null);
    assert.equal(first.house_consumption, null);
    assert.equal(second.battery_discharging, 0.012);
    assert.equal(second.battery_charging, 0.006);
    assert.equal(second.house_consumption, 0.043);
});

test('battery energy preserves local-midnight boundaries and marks missing boundary fields unavailable', () => {
    const network = [
        {_time: new Date(2026, 9, 13, 23, 59).toISOString(), _value: 600},
        {_time: new Date(2026, 9, 14).toISOString(), _value: 1200}
    ];
    const solar = network.map(point => ({...point, _value: 600}));
    const battery = network.map(point => ({
        _time: point._time, packInputPower: point._value, outputPackPower: point._value / 2
    }));
    const [first, second] = computeEnergy(network, solar, battery);
    assert.equal(first.battery_discharging, 0.015);
    assert.equal(first.battery_charging, 0.007);
    assert.equal(first.house_consumption, 0.035);
    assert.equal(second.battery_discharging, 0.005);
    assert.equal(second.battery_charging, 0.002);
    assert.equal(second.house_consumption, 0.01);

    delete battery[1].outputPackPower;
    for (const day of computeEnergy(network, solar, battery)) {
        assert.notEqual(day.battery_discharging, null);
        assert.equal(day.battery_charging, null);
        assert.equal(day.house_consumption, null);
    }
});
