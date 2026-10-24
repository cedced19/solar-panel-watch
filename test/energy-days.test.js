const assert = require('node:assert/strict');
const test = require('node:test');
const computeEnergy = require('../lib/compute-energy.js');
const {createEnergyDayStore} = require('../lib/energy-day-store.js');
const {createEnergyDays, isValidDay, localDayKey} = require('../lib/energy-days.js');

function setup(nowDate, devices) {
    const store = createEnergyDayStore(':memory:');
    const queries = [];
    let current = nowDate;
    const state = {
        data: {power1: [
            {_time: new Date(2026, 9, 13, 12).toISOString(), _value: 600},
            {_time: new Date(2026, 9, 13, 12, 1).toISOString(), _value: 600}
        ], power2: [], battery: []}
    };
    const influx = {
        async requestConsumptionOverRange(start, stop) {
            queries.push({start, stop});
            return state.data;
        },
        async requestDevicePowerOverRange(start, stop, names) {
            queries.push({start, stop, devices: names});
            return state.devicePower;
        }
    };
    const energyDays = createEnergyDays({store, influx, computeEnergy, devices, now: () => current});
    return {store, queries, state, energyDays, setNow(date) { current = date; }};
}

test('a complete stored day is served without a new query, a forced one recomputes it', async () => {
    const {queries, state, energyDays} = setup(new Date(2026, 9, 20));
    const row = await energyDays.getDay('2026-10-13');
    assert.equal(row.consumption_on_network, 0.012);
    assert.equal(row.complete, true);
    assert.deepEqual([queries[0].start, queries[0].stop], [new Date(2026, 9, 13), new Date(2026, 9, 14)]);
    assert.deepEqual(await energyDays.getDay('2026-10-13'), row);
    assert.equal(queries.length, 1);

    state.data = {...state.data, power1: state.data.power1.map(point => ({...point, _value: 1200}))};
    const forced = await energyDays.getDay('2026-10-13', {force: true});
    assert.equal(forced.consumption_on_network, 0.025);
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
