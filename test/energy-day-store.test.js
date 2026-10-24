const assert = require('node:assert/strict');
const test = require('node:test');
const {createEnergyDayStore} = require('../lib/energy-day-store.js');

const summary = {
    start_date: new Date(2026, 9, 13, 0, 0, 5), end_date: new Date(2026, 9, 13, 23, 59, 50),
    consumption_on_network: 2, introduced_on_network: -1, solar_panel: 6,
    battery_discharging: 4, battery_charging: 3, house_consumption: 8
};

test('the energy day store keeps one summary per day and upserts it', () => {
    const store = createEnergyDayStore(':memory:');
    const computedAt = new Date(2026, 9, 14, 1);
    const row = store.put('2026-10-13', summary, {complete: true, source: 'influx', computedAt});
    assert.deepEqual(row, {
        day: '2026-10-13', start_date: summary.start_date.toISOString(), end_date: summary.end_date.toISOString(),
        consumption_on_network: 2, introduced_on_network: -1, solar_panel: 6,
        battery_discharging: 4, battery_charging: 3, house_consumption: 8,
        complete: true, computed_at: computedAt.toISOString(), source: 'influx'
    });
    const updated = store.put('2026-10-13', {...summary, solar_panel: null, house_consumption: undefined},
        {complete: false, source: 'influx'});
    assert.equal(updated.solar_panel, null);
    assert.equal(updated.house_consumption, null);
    assert.equal(updated.complete, false);
    assert.equal(store.range().length, 1);
    store.close();
});

test('the energy day store reads inclusive ranges in day order and lists stored days', () => {
    const store = createEnergyDayStore(':memory:');
    for (const day of ['2026-10-15', '2026-10-13', '2026-10-14']) {
        store.put(day, summary, {complete: day !== '2026-10-15', source: 'influx'});
    }
    store.put('2026-10-16', null, {complete: true, source: 'influx'});
    assert.deepEqual(store.range('2026-10-14', '2026-10-15').map(row => row.day), ['2026-10-14', '2026-10-15']);
    assert.deepEqual(store.range('2026-10-15').map(row => row.day), ['2026-10-15', '2026-10-16']);
    assert.deepEqual(store.range(undefined, '2026-10-13').map(row => row.day), ['2026-10-13']);
    assert.equal(store.get('2026-10-12'), null);
    assert.deepEqual(store.get('2026-10-16').start_date, null);
    assert.deepEqual(store.days(), [
        {day: '2026-10-13', complete: true, has_data: true},
        {day: '2026-10-14', complete: true, has_data: true},
        {day: '2026-10-15', complete: false, has_data: true},
        {day: '2026-10-16', complete: true, has_data: false}
    ]);
    store.close();
});

test('insertIfAbsent never replaces a stored day', () => {
    const store = createEnergyDayStore(':memory:');
    assert.equal(store.insertIfAbsent('2026-10-13', summary, {complete: true, source: 'legacy'}), true);
    assert.equal(store.insertIfAbsent('2026-10-13', {...summary, solar_panel: 1},
        {complete: true, source: 'legacy'}), false);
    assert.equal(store.get('2026-10-13').solar_panel, 6);
    store.close();
});
