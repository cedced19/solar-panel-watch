const assert = require('node:assert/strict');
const test = require('node:test');
const {createEnergyAccumulator} = require('../lib/compute-energy.js');
const feedReadings = require('./feed-readings.js');
const {createEnergyDayStore} = require('../lib/energy-day-store.js');
const {createEnergyDays, isValidDay, localDayKey, previousDay} = require('../lib/energy-days.js');

function setup(nowDate, devices) {
    const store = createEnergyDayStore(':memory:');
    const queries = [];
    let current = nowDate;
    const state = {
        data: {power1: [
            {_time: new Date(2026, 9, 13, 12).toISOString(), _value: 600},
            {_time: new Date(2026, 9, 13, 12, 0, 30).toISOString(), _value: 600}
        ], power2: [], battery: []}
    };
    const influx = {
        async streamConsumptionOverRange(start, stop, sink) {
            queries.push({start, stop});
            feedReadings(sink, state.data);
        },
        async requestDevicePowerOverRange(start, stop, names) {
            queries.push({start, stop, devices: names});
            return state.devicePower;
        }
    };
    const energyDays = createEnergyDays({store, influx, createEnergyAccumulator, devices, now: () => current});
    return {store, queries, state, energyDays, setNow(date) { current = date; }};
}

test('a complete stored day is served without a new query, a forced one recomputes it', async () => {
    const {queries, state, energyDays} = setup(new Date(2026, 9, 20));
    const row = await energyDays.getDay('2026-10-13');
    assert.equal(row.consumption_on_network, 0.007);
    assert.equal(row.complete, true);
    assert.deepEqual([queries[0].start, queries[0].stop], [new Date(2026, 9, 13), new Date(2026, 9, 14)]);
    assert.deepEqual(await energyDays.getDay('2026-10-13'), row);
    assert.equal(queries.length, 1);

    state.data = {...state.data, power1: state.data.power1.map(point => ({...point, _value: 1200}))};
    const forced = await energyDays.getDay('2026-10-13', {force: true});
    assert.equal(forced.consumption_on_network, 0.015);
    assert.equal(queries.length, 2);
});

test('today is stored as partial and computed again until the day is over', async () => {
    const {queries, energyDays, setNow} = setup(new Date(2026, 9, 13, 18));
    assert.equal(energyDays.today(), '2026-10-13');
    assert.equal((await energyDays.getDay('2026-10-13')).complete, false);
    assert.deepEqual(energyDays.staleDays('2026-10-12', '2026-10-20'), ['2026-10-12', '2026-10-13']);
    await energyDays.getDay('2026-10-13');
    assert.equal(queries.length, 2);

    // Late samples: still partial shortly after midnight.
    setNow(new Date(2026, 9, 14, 0, 2));
    assert.equal((await energyDays.getDay('2026-10-13')).complete, false);
    setNow(new Date(2026, 9, 14, 0, 10));
    assert.equal((await energyDays.getDay('2026-10-13')).complete, true);
    assert.deepEqual(energyDays.staleDays('2026-10-13', '2026-10-14'), ['2026-10-14']);
    await energyDays.getDay('2026-10-13');
    assert.equal(queries.length, 4);
});

test('a partial day computed after it ended is not computed again unless forced', async () => {
    const {store, queries, energyDays} = setup(new Date(2026, 9, 20));
    store.put('2026-10-13', {start_date: new Date(2026, 9, 13, 8), end_date: new Date(2026, 9, 13, 20),
        consumption_on_network: 1}, {complete: false, source: 'legacy', computedAt: new Date(2026, 9, 15)});
    store.put('2026-10-14', {start_date: new Date(2026, 9, 14, 8), end_date: new Date(2026, 9, 14, 20),
        consumption_on_network: 1}, {complete: false, source: 'legacy', computedAt: new Date(2026, 9, 14, 21)});
    assert.deepEqual(energyDays.staleDays('2026-10-13', '2026-10-14'), ['2026-10-14']);
    assert.equal((await energyDays.getDay('2026-10-13')).consumption_on_network, 1);
    assert.equal(queries.length, 0);
});

test('an empty result keeps figures already stored for the day', async () => {
    const {store, state, energyDays} = setup(new Date(2026, 9, 20));
    store.put('2026-10-13', {start_date: new Date(2026, 9, 13), end_date: new Date(2026, 9, 13, 23, 59),
        consumption_on_network: 5, house_consumption: 9}, {complete: true, source: 'legacy'});
    state.data = {power1: [], power2: [], battery: []};
    const kept = await energyDays.getDay('2026-10-13', {force: true});
    assert.equal(kept.consumption_on_network, 5);
    assert.equal(kept.source, 'legacy');
    assert.equal(kept.computed_at, new Date(2026, 9, 20).toISOString());
    const empty = await energyDays.getDay('2026-10-12');
    assert.equal(empty.consumption_on_network, null);
    assert.equal(empty.complete, true);
});

test('concurrent requests for one day share a single query', async () => {
    const {queries, energyDays} = setup(new Date(2026, 9, 20));
    const [a, b] = await Promise.all([energyDays.getDay('2026-10-13'), energyDays.getDay('2026-10-13', {force: true})]);
    assert.deepEqual(a, b);
    assert.equal(queries.length, 1);
});

test('day keys are validated as real local calendar days', () => {
    for (const day of ['2026-10-13', '2024-02-29']) assert.equal(isValidDay(day), true, day);
    for (const day of ['2026-02-30', '2026-13-01', '26-10-13', '2026-10-13T00:00', undefined]) {
        assert.equal(isValidDay(day), false, String(day));
    }
    assert.equal(localDayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('the previous day crosses month, year and daylight saving changes', () => {
    assert.equal(previousDay('2026-10-13'), '2026-10-12');
    assert.equal(previousDay('2026-03-01'), '2026-02-28');
    assert.equal(previousDay('2026-01-01'), '2025-12-31');
    assert.equal(previousDay('2026-03-30'), '2026-03-29');
    assert.equal(previousDay('2026-10-26'), '2026-10-25');
});

test('the configured devices are summed into one figure, counted up to now for today', async () => {
    const {queries, state, energyDays, setNow} = setup(new Date(2026, 9, 13, 18), ['water-heater', 'heat-pump']);
    state.devicePower = {
        'water-heater': [{_time: new Date(2026, 9, 13, 12).toISOString(), _value: 2000}],
        'heat-pump': [{_time: new Date(2026, 9, 13, 11).toISOString(), _value: 1000},
            {_time: new Date(2026, 9, 13, 12).toISOString(), _value: 0}]
    };
    // 2000 W from 12:00 to 18:00 plus 1000 W for one hour.
    assert.equal((await energyDays.getDay('2026-10-13')).devices_consumption, 13);
    assert.deepEqual(queries.find(query => query.devices).devices, ['water-heater', 'heat-pump']);
    setNow(new Date(2026, 9, 14, 1));
    // Once the day is over, the water heater counts until midnight.
    assert.equal((await energyDays.getDay('2026-10-13')).devices_consumption, 25);
});

test('without devices the figure stays empty and no device power is queried', async () => {
    const {queries, energyDays} = setup(new Date(2026, 9, 20));
    assert.equal((await energyDays.getDay('2026-10-13')).devices_consumption, null);
    assert.ok(queries.every(query => !query.devices));
});

test('coverage is measured over the whole day once it is over, and up to now for today', async () => {
    const {state, energyDays, setNow} = setup(new Date(2026, 9, 14, 1));
    state.data = {...state.data, power2: state.data.power1};
    const complete = await energyDays.getDay('2026-10-13');
    // 30 s held plus the 15 s tail out of 24 hours, for grid and solar; no battery readings.
    assert.equal(complete.coverage_network, Math.round(45 / 86400 * 1000) / 10);
    assert.equal(complete.coverage_solar, complete.coverage_network);
    assert.equal(complete.coverage_battery, null);

    // At 12:00:45 the period is midnight to now, and the tail counts only up to now.
    setNow(new Date(2026, 9, 13, 12, 0, 45));
    const today = await energyDays.getDay('2026-10-13', {force: true});
    assert.equal(today.complete, false);
    assert.equal(today.coverage_network, Math.round(45 / (12 * 3600 + 45) * 1000) / 10);
});

test('a gap in the readings lowers the coverage of the day and is not integrated', async () => {
    const {state, energyDays} = setup(new Date(2026, 9, 20));
    // 600 W every 10 s for a minute, nothing for 10 minutes, then again for a minute.
    const burst = (minute) => Array.from({length: 7}, (_, i) =>
        ({_time: new Date(2026, 9, 13, 12, minute, i * 10).toISOString(), _value: 600}));
    state.data = {power1: [...burst(0), ...burst(11)], power2: [], battery: []};
    const row = await energyDays.getDay('2026-10-13');
    // Held: 60 s, then 30 s of the 10-minute gap, then 60 s and the 15 s tail = 165 s at 600 W = 27.5 Wh.
    assert.equal(row.consumption_on_network, 0.027);
    assert.equal(row.coverage_network, Math.round(165 / 86400 * 1000) / 10);
});

test('the highest battery level of the day is stored with the day, null when no level was read', async () => {
    const {store, state, energyDays} = setup(new Date(2026, 9, 20));
    const level = (minute, soc) => ({_time: new Date(2026, 9, 13, 12, minute).toISOString(), _value: soc,
        packInputPower: 0, outputPackPower: 0});
    state.data = {...state.data, battery: [level(0, 35), level(1, 92.3), level(2, 71)]};
    assert.equal((await energyDays.getDay('2026-10-13')).battery_max_soc, 92.3);
    assert.equal(store.get('2026-10-13').battery_max_soc, 92.3);

    state.data = {...state.data, battery: []};
    assert.equal((await energyDays.getDay('2026-10-13', {force: true})).battery_max_soc, null);
});
