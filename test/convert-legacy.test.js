const assert = require('node:assert/strict');
const test = require('node:test');
const {createEnergyDayStore} = require('../lib/energy-day-store.js');
const {selectDailySummaries, convert} = require('../lab/convert-legacy/convert.js');

const at = (day, hours, minutes = 0) => new Date(2026, 9, day, hours, minutes).toISOString();
const row = (start, end, values) => ({start_date: start, end_date: end,
    consumption_on_network: 2, introduced_on_network: -1, solar_panel: 6, house_consumption: 7, ...values});
const fullDay = (day, values) => row(at(day, 0, 0), at(day, 23, 59), values);

test('the converter keeps one summary per day: complete, then battery data, then span, then recency', () => {
    const entries = [
        {date: at(14, 9), period: '3d', result: [row(at(13, 9), at(13, 23, 59)), fullDay(13, {solar_panel: 1})]},
        // Complete battery readings beat a later legacy row of the same day.
        {date: at(14, 10), period: '2026-10-13', result: [fullDay(13, {battery_discharging: 1, battery_charging: 0})]},
        {date: at(14, 11), period: '1d', result: [fullDay(13, {solar_panel: 3})]},
        // A partial battery-aware row does not replace a complete legacy one.
        {date: at(15, 1), period: '2d', result: [fullDay(14), row(at(14, 6), at(14, 20),
            {battery_discharging: 1, battery_charging: 1})]},
        // Without a complete row: widest span, then latest request.
        {date: at(15, 12), period: '1d', result: [row(at(15, 6), at(15, 12), {solar_panel: 1})]},
        {date: at(15, 13), period: '1d', result: [row(at(15, 0), at(15, 13), {solar_panel: 2})]},
        {date: at(15, 14), period: '1d', result: [row(at(15, 0), at(15, 13), {solar_panel: 3})]}
    ];
    const summaries = selectDailySummaries(entries);
    assert.deepEqual(summaries.map(s => [s.day, s.complete, s.requestDate]), [
        ['2026-10-13', true, at(14, 10)], ['2026-10-14', true, at(15, 1)], ['2026-10-15', false, at(15, 14)]
    ]);
    assert.equal(summaries[0].row.battery_discharging, 1);
    assert.equal(summaries[1].row.battery_discharging, undefined);
    assert.equal(summaries[2].row.solar_panel, 3);
});

test('the converter writes legacy rows with their request date and never overwrites stored days', () => {
    const store = createEnergyDayStore(':memory:');
    store.put('2026-10-14', fullDay(14, {solar_panel: 9}), {complete: true, source: 'influx'});
    const entries = [{date: at(15, 9), period: '3d',
        result: [fullDay(13), fullDay(14), row(at(15, 0), at(15, 9))]}];
    assert.deepEqual(convert(entries, store), {written: 2, complete: 1, partial: 1, skipped: 1});
    assert.equal(store.get('2026-10-14').solar_panel, 9);
    assert.deepEqual([store.get('2026-10-13').source, store.get('2026-10-13').complete,
        store.get('2026-10-13').computed_at], ['legacy', true, at(15, 9)]);
    assert.equal(store.get('2026-10-15').complete, false);
    assert.deepEqual(convert(entries, store), {written: 0, complete: 0, partial: 0, skipped: 3});
});

test('invalid negative battery readings do not beat complete zero readings of the same day', () => {
    const [summary] = selectDailySummaries([
        {date: at(14, 9), period: '1d', result: [fullDay(13, {battery_discharging: 0, battery_charging: 0})]},
        {date: at(14, 10), period: '1d', result: [fullDay(13, {battery_discharging: -1, battery_charging: 0})]}
    ]);
    assert.equal(summary.row.battery_discharging, 0);
});
