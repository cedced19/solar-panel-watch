const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const test = require('node:test');
const {createEnergyDayStore} = require('../lib/energy-day-store.js');

const summary = {
    start_date: new Date(2026, 9, 13, 0, 0, 5), end_date: new Date(2026, 9, 13, 23, 59, 50),
    consumption_on_network: 2, introduced_on_network: -1, solar_panel: 6,
    battery_discharging: 4, battery_charging: 3, charging_energy_from_network: 1, house_consumption: 8,
    devices_consumption: 2, coverage_network: 99.5, coverage_solar: 98.2, coverage_battery: 100, battery_max_soc: 87.5
};

test('the energy day store keeps one summary per day and upserts it', () => {
    const store = createEnergyDayStore(':memory:');
    const computedAt = new Date(2026, 9, 14, 1);
    const row = store.put('2026-10-13', summary, {complete: true, source: 'influx', computedAt});
    assert.deepEqual(row, {
        day: '2026-10-13', start_date: summary.start_date.toISOString(), end_date: summary.end_date.toISOString(),
        consumption_on_network: 2, introduced_on_network: -1, solar_panel: 6,
        battery_discharging: 4, battery_charging: 3, charging_energy_from_network: 1, house_consumption: 8,
        devices_consumption: 2, coverage_network: 99.5, coverage_solar: 98.2, coverage_battery: 100, battery_max_soc: 87.5,
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

test('a store file from before a field existed gets its column, null for the days already stored', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'energy-day-store-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const filename = path.join(dir, 'energy-days.sqlite');
    const old = new DatabaseSync(filename);
    old.exec(`CREATE TABLE energy_day (day TEXT PRIMARY KEY, start_date TEXT, end_date TEXT,
        consumption_on_network REAL, introduced_on_network REAL, solar_panel REAL,
        battery_discharging REAL, battery_charging REAL, house_consumption REAL,
        complete INTEGER NOT NULL, computed_at TEXT NOT NULL, source TEXT NOT NULL)`);
    old.exec(`INSERT INTO energy_day VALUES ('2026-10-12', NULL, NULL, 2, -1, 6, 4, 3, 8, 1,
        '2026-10-13T00:00:00.000Z', 'influx')`);
    old.close();

    const store = createEnergyDayStore(filename);
    const stored = store.get('2026-10-12');
    assert.equal(stored.battery_charging, 3);
    assert.equal(stored.charging_energy_from_network, null);
    assert.equal(stored.coverage_network, null);
    assert.equal(stored.battery_max_soc, null);
    assert.equal(store.put('2026-10-13', summary, {complete: true, source: 'influx'}).charging_energy_from_network, 1);
    assert.equal(store.get('2026-10-13').coverage_solar, 98.2);
    assert.equal(store.get('2026-10-13').battery_max_soc, 87.5);
    store.close();
    const reopened = createEnergyDayStore(filename);
    assert.equal(reopened.get('2026-10-13').charging_energy_from_network, 1);
    reopened.close();
});
