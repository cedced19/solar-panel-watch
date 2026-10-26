const assert = require('node:assert/strict');
const test = require('node:test');
const realComputeEnergy = require('../lib/compute-energy');
const {devicesEnergy, MAX_HOLD_MS, createEnergyAccumulator} = realComputeEnergy;

// Most fixtures below read once a minute (or hourly) to keep the arithmetic
// readable, so they lift the hold cap. The hold and coverage tests use the
// default cap through realComputeEnergy.
const computeEnergy = (network, solar, battery, options) =>
    realComputeEnergy(network, solar, battery, {maxHoldMs: Infinity, ...options});

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
        solar_panel: 0.06, battery_discharging: 0, battery_charging: 0, charging_energy_from_network: 0,
        house_consumption: 0.07, coverage_network: 100, coverage_solar: 100, coverage_battery: 100,
        battery_max_soc: 50
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
    assert.equal(result[0].house_consumption, 0.027);
    assert.equal(result[1].consumption_on_network, 0.005);
    assert.equal(result[1].solar_panel, 0.002);
    assert.equal(result[1].house_consumption, 0.007);

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

test('omitted, empty and older SOC-only battery history retain grid-plus-solar household energy', () => {
    for (const battery of [undefined, [], points([50, 49, 48])]) {
        const [day] = computeEnergy(points([600, -300, 1200]), points([1200, 1800, 2400]), battery);
        assert.equal(day.consumption_on_network, 0.015);
        assert.equal(day.introduced_on_network, -0.005);
        assert.equal(day.solar_panel, 0.06);
        assert.equal(day.battery_discharging, null);
        assert.equal(day.battery_charging, null);
        assert.equal(day.house_consumption, 0.07);
    }
});

test('either missing battery direction excludes both directions from household energy for that day', () => {
    for (const field of ['packInputPower', 'outputPackPower']) {
        const battery = batteryPoints([600, 1200, 1800], [300, 600, 900]);
        delete battery[1][field];
        const [day] = computeEnergy(points([600, -300, 1200]), points([1200, 1800, 2400]), battery);
        assert.equal(day.battery_discharging, field === 'packInputPower' ? null : 0.037);
        assert.equal(day.battery_charging, field === 'outputPackPower' ? null : 0.018);
        assert.equal(day.house_consumption, 0.07);
    }
});

test('invalid battery power remains unavailable while a measured zero remains zero', () => {
    for (const value of [null, NaN, Infinity, -1]) {
        const battery = batteryPoints([0, 0]);
        battery[1].packInputPower = value;
        const [day] = computeEnergy(points([600, 600]), points([0, 0]), battery);
        assert.equal(day.battery_discharging, null);
        assert.equal(day.battery_charging, 0);
        assert.equal(day.house_consumption, 0.012);
    }
    const [day] = computeEnergy(points([600, 600]), points([0, 0]), batteryPoints([0, 0]));
    assert.equal(day.battery_discharging, 0);
    assert.equal(day.battery_charging, 0);
    assert.equal(day.house_consumption, 0.012);
});

test('absent or SOC-only history uses the base estimate while the next day includes complete battery energy', () => {
    for (const olderBattery of [[], points([50, 49])]) {
        const [first, second] = computeEnergy(
            [...points([600, 600]), ...points([600, 600], 14)],
            [...points([1200, 1200]), ...points([1200, 1200], 14)],
            [...olderBattery, ...batteryPoints([600, 600], [300, 300], 14)]
        );
        assert.equal(first.battery_discharging, null);
        assert.equal(first.battery_charging, null);
        assert.equal(first.house_consumption, 0.037);
        assert.equal(second.battery_discharging, 0.012);
        assert.equal(second.battery_charging, 0.006);
        assert.equal(second.house_consumption, 0.043);
    }
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
    for (const [i, day] of computeEnergy(network, solar, battery).entries()) {
        assert.notEqual(day.battery_discharging, null);
        assert.equal(day.battery_charging, null);
        assert.equal(day.house_consumption, i === 0 ? 0.027 : 0.007);
    }
});

test('battery charging between 22:00 and 06:00 local time is counted as charging from the grid', () => {
    const at = (hour, value) => ({_time: new Date(2026, 9, 13, hour).toISOString(), packInputPower: 0, outputPackPower: value});
    // 05:00-07:00 at 600 W (one hour before 06:00), 07:00-21:00 at 1200 W,
    // 21:00-23:00 at 400 W (one hour after 22:00), then the 15 s tail at 300 W.
    const battery = [at(5, 600), at(7, 1200), at(21, 400), at(23, 300)];
    const network = battery.map(point => ({_time: point._time, _value: 600}));
    const [day] = computeEnergy(network, network, battery);
    assert.equal(day.battery_charging, 18.801);
    assert.equal(day.charging_energy_from_network, 1.001);
});

test('charging from the grid is unavailable whenever battery charging is', () => {
    const network = points([600, 600]);
    for (const battery of [[], points([50, 49])]) {
        const [day] = computeEnergy(network, network, battery);
        assert.equal(day.charging_energy_from_network, null);
    }
    const battery = batteryPoints([0, 0], [300, 300]);
    delete battery[1].outputPackPower;
    assert.equal(computeEnergy(network, network, battery)[0].charging_energy_from_network, null);
});

test('device energy holds each power until the next value, from the last value before the day to its end', () => {
    const at = (date, hour, minute = 0) => new Date(2026, 9, date, hour, minute).toISOString();
    const power = {
        // On since the evening before, then two runs; the last one goes past midnight.
        'water-heater': [{_time: at(12, 23), _value: 1000}, {_time: at(13, 1), _value: 0},
            {_time: at(13, 12), _value: 2000}, {_time: at(13, 13, 30), _value: 0},
            {_time: at(13, 23), _value: 500}, {_time: at(14, 1), _value: 0}],
        // Normal mode writes on every call.
        'heat-pump': [{_time: at(13, 10), _value: 2600}, {_time: at(13, 10, 15), _value: 2600},
            {_time: at(13, 10, 30), _value: 0}],
        'never-called': []
    };
    // 1 + 3 + 0.5 kWh for the water heater, 1.3 kWh for the heat pump.
    assert.equal(devicesEnergy(power, new Date(2026, 9, 13), new Date(2026, 9, 14)), 5.8);
    // Today is counted up to now: 1 + 1.5 + 1.3 kWh at 12:45.
    assert.equal(devicesEnergy(power, new Date(2026, 9, 13), new Date(2026, 9, 13, 12, 45)), 3.8);
    assert.equal(devicesEnergy({}, new Date(2026, 9, 13), new Date(2026, 9, 14)), 0);
});

test('device energy skips invalid readings and never counts negative power', () => {
    const at = hour => new Date(2026, 9, 13, hour).toISOString();
    const power = {device: [{_time: at(1), _value: 1000}, {_time: 'not a date', _value: 5000},
        {_time: at(2), _value: null}, {_time: at(3), _value: -500}, {_time: at(4), _value: 0}]};
    // 1000 W from 01:00 to 03:00 (the null reading does not change it), nothing below zero.
    assert.equal(devicesEnergy(power, new Date(2026, 9, 13), new Date(2026, 9, 14)), 2);
});

// Whole kWh of W·s, floored to 3 decimals like the reported fields.
const kWh = wattSeconds => Math.floor(wattSeconds / 3600) / 1000;

// Readings every `step` seconds from 12:00:00 local time on 13 October.
function every(step, values, day = 13) {
    return values.map((value, i) => ({
        _time: new Date(2026, 9, day, 12, 0, i * step).toISOString(), _value: value
    }));
}

test('a reading is held for at most 30 seconds, then the span is missing', () => {
    assert.equal(MAX_HOLD_MS, 30000);
    // 1000 W is held 30 s of the 10 minutes before the next reading, plus the 15 s tail of 2000 W.
    const network = [...every(10, [1000]), ...every(10, [2000]).map(point =>
        ({...point, _time: new Date(Date.parse(point._time) + 10 * 60 * 1000).toISOString()}))];
    const [day] = realComputeEnergy(network, []);
    assert.equal(day.consumption_on_network, kWh(1000 * 30 + 2000 * 15));
    // Held 45 s out of the 10 min 15 s between the first reading and the end of the last one.
    assert.equal(day.coverage_network, Math.round(45 / 615 * 1000) / 10);
    // The old behaviour, a reading held until the next one whatever the gap, stays available.
    assert.equal(realComputeEnergy(network, [], [], {maxHoldMs: Infinity})[0].consumption_on_network,
        kWh(1000 * 600 + 2000 * 15));
});

test('readings up to 30 seconds apart are fully covered and integrate like before', () => {
    const [day] = realComputeEnergy(every(30, [3600, 3600, 3600]), every(30, [1800, 1800, 1800]));
    // 3600 W for 30 + 30 s plus the 15 s tail.
    assert.equal(day.consumption_on_network, kWh(3600 * 75));
    assert.equal(day.coverage_network, 100);
    assert.equal(day.coverage_solar, 100);
    assert.equal(day.solar_panel, kWh(1800 * 75));
});

test('each series reports its own coverage, null when it has no readings that day', () => {
    const network = every(10, [600, 600, 600, 600, 600, 600]);
    // Solar stops after 20 s of the 65 s window; the battery has the same gap in its other direction only.
    const solar = every(10, [1000, 1000]);
    const battery = every(10, [0, 0, 0, 0, 0, 0]).map(point => ({_time: point._time, packInputPower: 0, outputPackPower: 0}));
    const [day] = realComputeEnergy(network, solar, battery);
    assert.equal(day.coverage_network, 100);
    // Two readings: 10 s held, then a 15 s tail, out of 65 s.
    assert.equal(day.coverage_solar, Math.round(25 / 65 * 1000) / 10);
    assert.equal(day.coverage_battery, 100);
    const [bare] = realComputeEnergy(network, [], undefined);
    assert.equal(bare.coverage_solar, null);
    assert.equal(bare.coverage_battery, null);
});

test('coverage is measured over the requested period, so a late first reading or an early stop counts as missing', () => {
    const network = every(10, [600, 600, 600]);
    const start = new Date(2026, 9, 13, 12).getTime();
    // Readings cover 12:00:00-12:00:35 of a window opening at 11:59:30 and closing at 12:01:10.
    const [day] = realComputeEnergy(network, [], [], {from: start - 30000, to: start + 70000});
    assert.equal(day.coverage_network, 35);
    // A window that fits inside the readings is fully covered.
    assert.equal(realComputeEnergy(network, [], [], {from: start + 5000, to: start + 20000})[0].coverage_network, 100);
});

test('coverage is relative to each local day, and counts the last reading only up to the end of the period', () => {
    const at = (day, minute, second, value) => ({_time: new Date(2026, 9, day, 0, minute, second).toISOString(), _value: value});
    const late = (second, value) => ({_time: new Date(2026, 9, 13, 23, 59, second).toISOString(), _value: value});
    const network = [
        {_time: new Date(2026, 9, 13, 23, 58).toISOString(), _value: 600},
        {_time: new Date(2026, 9, 13, 23, 58, 30).toISOString(), _value: 600},
        late(0, 600), late(30, 600), at(14, 0, 30, 600), at(14, 1, 0, 600)
    ];
    const [first, second] = realComputeEnergy(network, [], [], {
        from: new Date(2026, 9, 13, 23, 58).getTime(), to: new Date(2026, 9, 14, 0, 1).getTime()
    });
    // 13th: 120 s from 23:58 to midnight; three 30 s holds and a 15 s tail (the next reading is a day later).
    assert.equal(first.coverage_network, 87.5);
    // 14th: the first 30 s have no reading; the last reading is at the end of the period, so it adds no tail.
    assert.equal(second.coverage_network, 50);
});

test('night charging and battery energy use the same hold cap', () => {
    // 5 s readings over 20 s at 3600 W, then nothing for hours, in the 22:00-06:00 window.
    const at = (second, value) => ({_time: new Date(2026, 9, 13, 23, 0, second).toISOString(),
        packInputPower: 0, outputPackPower: value});
    const battery = [at(0, 3600), at(5, 3600), at(10, 3600), at(15, 3600), at(20, 3600)];
    const network = battery.map(point => ({_time: point._time, _value: 100}));
    const [day] = realComputeEnergy(network, network, battery);
    // 20 s between readings plus the 15 s tail.
    assert.equal(day.battery_charging, 0.035);
    assert.equal(day.charging_energy_from_network, 0.035);
    assert.equal(day.coverage_battery, 100);
});

// Readings of two days with a gap, a battery row missing a field and a row at midnight.
function mixedReadings() {
    const t = (day, hour, minute, second) => new Date(2026, 9, day, hour, minute, second).toISOString();
    const network = [[13, 23, 58, 0, 600], [13, 23, 58, 20, -300], [13, 23, 59, 50, 900], [14, 0, 0, 0, 1200],
        [14, 0, 0, 20, 300], [14, 0, 0, 40, -50]].map(([d, h, m, sec, v]) => ({_time: t(d, h, m, sec), _value: v}));
    const solar = network.filter((_, i) => i !== 2).map(point => ({...point, _value: Math.abs(point._value)}));
    const battery = [[13, 23, 58, 0, 100, 0], [13, 23, 58, 20, 0, 300], [14, 0, 0, 0, 50, 10], [14, 0, 0, 20, 70, 20]]
        .map(([d, h, m, sec, discharge, charge]) =>
            ({_time: t(d, h, m, sec), _value: 50, packInputPower: discharge, outputPackPower: charge}));
    return {network, solar, battery};
}

test('feeding readings one by one gives the same days as the arrays, in any interleaving of the sources', () => {
    const {network, solar, battery} = mixedReadings();
    const expected = realComputeEnergy(network, solar, battery);
    assert.equal(expected.length, 2);
    for (const order of [['n', 's', 'b'], ['b', 's', 'n'], ['s', 'n', 'b']]) {
        const accumulator = createEnergyAccumulator();
        for (const source of order) {
            if (source === 'n') network.forEach(point => accumulator.addNetwork(point._time, point._value));
            if (source === 's') solar.forEach(point => accumulator.addSolar(point._time, point._value));
            if (source === 'b') battery.forEach(row => accumulator.addBattery(row._time, row.packInputPower, row.outputPackPower, row._value));
        }
        assert.deepEqual(accumulator.result(), expected, order.join());
    }
});

test('a missing battery field makes that direction unavailable for the day, also when streamed', () => {
    const {network, solar, battery} = mixedReadings();
    const accumulator = createEnergyAccumulator();
    network.forEach(point => accumulator.addNetwork(point._time, point._value));
    solar.forEach(point => accumulator.addSolar(point._time, point._value));
    battery.forEach((row, i) => accumulator.addBattery(row._time, row.packInputPower, i === 1 ? undefined : row.outputPackPower));
    const [first, second] = accumulator.result();
    assert.equal(first.battery_charging, null);
    assert.notEqual(first.battery_discharging, null);
    // The row at midnight closes the first day and opens the second: charging is available for the second one.
    assert.notEqual(second.battery_charging, null);
});

test('the result can be read while readings keep coming, and again afterwards', () => {
    const {network} = mixedReadings();
    const accumulator = createEnergyAccumulator();
    network.slice(0, 3).forEach(point => accumulator.addNetwork(point._time, point._value));
    const partial = accumulator.result();
    assert.deepEqual(accumulator.result(), partial, 'reading the result changes nothing');
    network.slice(3).forEach(point => accumulator.addNetwork(point._time, point._value));
    assert.deepEqual(accumulator.result(), realComputeEnergy(network));
    assert.notDeepEqual(accumulator.result(), partial);
});

test('times may be ISO strings or milliseconds, and unreadable ones are ignored', () => {
    const start = new Date(2026, 9, 13, 12).getTime();
    const iso = createEnergyAccumulator();
    const ms = createEnergyAccumulator();
    for (const [i, value] of [600, 600, 600].entries()) {
        iso.addNetwork(new Date(start + i * 10000).toISOString(), value);
        ms.addNetwork(start + i * 10000, value);
    }
    ms.addNetwork('not a date', 5000);
    ms.addNetwork(start + 30000, NaN);
    assert.deepEqual(ms.result(), iso.result());
});

test('a whole day of one-second readings is integrated with full coverage', () => {
    const start = new Date(2026, 9, 13).getTime();
    const accumulator = createEnergyAccumulator();
    for (let second = 0; second < 86400; second++) {
        accumulator.addNetwork(start + second * 1000, 600);
        accumulator.addSolar(start + second * 1000, 100);
        accumulator.addBattery(start + second * 1000, 0, 0);
    }
    const [day] = accumulator.result({from: start, to: start + 86400000});
    // 600 W over 86399 s and the last second, whose 15 s tail stops at midnight in the coverage but not in the energy.
    assert.equal(day.consumption_on_network, kWh(600 * (86399 + 15)));
    assert.equal(day.solar_panel, kWh(100 * (86399 + 15)));
    assert.deepEqual([day.coverage_network, day.coverage_solar, day.coverage_battery], [100, 100, 100]);
});

test('the battery level peak is the highest valid level of each local day, whatever else the rows carry', () => {
    const at = (day, hour, minute, level) => ({_time: new Date(2026, 9, day, hour, minute).toISOString(), _value: level});
    const network = [at(13, 8, 0, 100), at(13, 20, 0, 100), at(14, 8, 0, 100), at(14, 9, 0, 100)];
    const accumulator = createEnergyAccumulator();
    network.forEach(point => accumulator.addNetwork(point._time, point._value));
    // Rows without power fields still carry a level; invalid levels are ignored.
    accumulator.addBattery(at(13, 8, 0)._time, undefined, undefined, 40);
    accumulator.addBattery(at(13, 12, 0)._time, 0, 0, 87.46);
    accumulator.addBattery(at(13, 13, 0)._time, 0, 0, 101);
    accumulator.addBattery(at(13, 14, 0)._time, 0, 0, -5);
    accumulator.addBattery(at(13, 15, 0)._time, 0, 0, NaN);
    accumulator.addBattery(at(13, 16, 0)._time, 0, 0, undefined);
    accumulator.addBattery(at(13, 18, 0)._time, 0, 0, 60);
    accumulator.addBattery(at(14, 8, 0)._time, 0, 0, 30);
    const [first, second] = accumulator.result();
    assert.equal(first.battery_max_soc, 87.5);
    assert.equal(second.battery_max_soc, 30);
});

test('the battery level peak is null without a valid level, and can be 0', () => {
    const network = points([600, 600]);
    const [none] = realComputeEnergy(network, [], batteryPoints([0, 0]).map(({_value, ...row}) => row));
    assert.equal(none.battery_max_soc, null);
    const [empty] = realComputeEnergy(network, [], [{_time: network[0]._time, _value: 0, packInputPower: 0, outputPackPower: 0}]);
    assert.equal(empty.battery_max_soc, 0);
    assert.equal(realComputeEnergy(network)[0].battery_max_soc, null);
});

test('a level stamped at midnight belongs to the new day only', () => {
    const t = (day, hour, minute) => new Date(2026, 9, day, hour, minute).getTime();
    const accumulator = createEnergyAccumulator();
    for (const [ts, value] of [[t(13, 23, 59), 600], [t(14, 0, 0), 600], [t(14, 0, 1), 600]]) accumulator.addNetwork(ts, value);
    accumulator.addBattery(t(13, 23, 58), 0, 0, 50);
    accumulator.addBattery(t(14, 0, 0), 0, 0, 90);
    const [first, second] = accumulator.result();
    assert.equal(first.battery_max_soc, 50);
    assert.equal(second.battery_max_soc, 90);
});
