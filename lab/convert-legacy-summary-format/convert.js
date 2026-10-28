// Converts the former energy request history (energy-query-save.json, one
// entry per request) into the energy day store (one summary per local day).
//
// Usage, with the server's timezone so that local days match:
//   TZ=Europe/Paris node lab/convert-legacy/convert.js [input] [output]
// Defaults: lab/convert-legacy/energy-query-save.json and ./energy-days.sqlite.
// Days already in the store are kept as they are.
const fs = require('fs');
const path = require('path');
const {createEnergyDayStore} = require('../../lib/energy-day-store.js');
const {localDayKey, dayBounds} = require('../../lib/energy-days.js');

// A saved row covers its whole day when its readings start and end within
// this delay of the day boundaries (samples arrive every 15 s).
const BOUNDARY_MS = 5 * 60 * 1000;

const isComplete = (day, row) => {
    const {start, stop} = dayBounds(day);
    return Date.parse(row.start_date) - start.getTime() <= BOUNDARY_MS &&
        stop.getTime() - Date.parse(row.end_date) <= BOUNDARY_MS;
};

// Same order as the former graph page: complete battery readings, then the
// schema with battery fields, then legacy rows.
const batteryTier = row => {
    const values = [row.battery_discharging, row.battery_charging];
    if (values.every(value => Number.isFinite(value) && value >= 0)) return 2;
    return ('battery_discharging' in row && 'battery_charging' in row) ? 1 : 0;
};

const span = row => Date.parse(row.end_date) - Date.parse(row.start_date);

// Positive when a is the better summary of the day.
const compare = (a, b) => (a.complete - b.complete) || (batteryTier(a.row) - batteryTier(b.row)) ||
    (span(a.row) - span(b.row)) || (Date.parse(a.requestDate) - Date.parse(b.requestDate));

// One {day, row, complete, requestDate} per local day of start_date, sorted by day.
function selectDailySummaries(entries) {
    const best = new Map();
    for (const entry of entries) {
        for (const row of entry.result || []) {
            if (!row || !row.start_date || !row.end_date) continue;
            const day = localDayKey(new Date(row.start_date));
            const candidate = {day, row, complete: isComplete(day, row), requestDate: entry.date};
            if (!best.has(day) || compare(candidate, best.get(day)) > 0) best.set(day, candidate);
        }
    }
    return Array.from(best.values()).sort((a, b) => a.day < b.day ? -1 : 1);
}

function convert(entries, store) {
    const counts = {written: 0, complete: 0, partial: 0, skipped: 0};
    for (const summary of selectDailySummaries(entries)) {
        const written = store.insertIfAbsent(summary.day, summary.row, {
            complete: summary.complete, source: 'legacy', computedAt: summary.requestDate
        });
        if (!written) {
            counts.skipped++;
            continue;
        }
        counts.written++;
        counts[summary.complete ? 'complete' : 'partial']++;
    }
    return counts;
}

if (require.main === module) {
    const input = process.argv[2] || path.join(__dirname, 'energy-query-save.json');
    const output = process.argv[3] || 'energy-days.sqlite';
    const store = createEnergyDayStore(output);
    try {
        const counts = convert(JSON.parse(fs.readFileSync(input, 'utf8')), store);
        console.log(`${input} -> ${output} (TZ ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
        console.log(`written: ${counts.written} (complete: ${counts.complete}, partial: ${counts.partial}),` +
            ` already stored: ${counts.skipped}`);
    } finally {
        store.close();
    }
}

module.exports = {selectDailySummaries, convert};
