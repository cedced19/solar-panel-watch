// Energy summaries per local calendar day, computed from one day of raw
// readings and kept in the energy day store. A day computed before it ended
// (plus a delay for late samples) is partial and gets computed again.
const COMPLETE_DELAY_MS = 5 * 60 * 1000;
const VALID_DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function padTwo(n) {
    return (n < 10 ? '0' : '') + n;
}

// Local calendar day key (YYYY-MM-DD) in the server's timezone, matching the
// day boundaries used by computeEnergy().
function localDayKey(date) {
    return date.getFullYear() + '-' + padTwo(date.getMonth() + 1) + '-' + padTwo(date.getDate());
}

function isValidDay(day) {
    if (typeof day !== 'string' || !VALID_DAY_REGEX.test(day)) return false;
    return localDayKey(dayBounds(day).start) === day;
}

function dayBounds(day) {
    const [year, month, date] = day.split('-').map(part => parseInt(part, 10));
    return {start: new Date(year, month - 1, date), stop: new Date(year, month - 1, date + 1)};
}

function nextDay(day) {
    return localDayKey(dayBounds(day).stop);
}

function createEnergyDays({store, influx, computeEnergy, now = () => new Date()}) {
    const inFlight = new Map();

    // A partial row computed after the day ended cannot get better data, so
    // it is not computed again unless forced.
    function isStale(row) {
        if (!row) return true;
        if (row.complete) return false;
        return Date.parse(row.computed_at) < dayBounds(row.day).stop.getTime() + COMPLETE_DELAY_MS;
    }

    async function compute(day) {
        const {start, stop} = dayBounds(day);
        const data = await influx.requestConsumptionOverRange(start, stop);
        const summary = computeEnergy(data.power1, data.power2, data.battery)
            .find(entry => localDayKey(new Date(entry.start_date)) === day) || null;
        const computedAt = now();
        const existing = store.get(day);
        // Raw readings of old days may be gone: keep the figures already saved.
        if (!summary && existing && existing.consumption_on_network !== null) {
            return store.put(day, existing, {complete: existing.complete, source: existing.source, computedAt});
        }
        return store.put(day, summary, {
            complete: computedAt.getTime() >= stop.getTime() + COMPLETE_DELAY_MS,
            source: 'influx',
            computedAt
        });
    }

    function computeDay(day) {
        if (!inFlight.has(day)) {
            inFlight.set(day, compute(day).finally(() => inFlight.delete(day)));
        }
        return inFlight.get(day);
    }

    return {
        store,
        isStale,
        today() {
            return localDayKey(now());
        },
        async getDay(day, {force = false} = {}) {
            const row = store.get(day);
            if (!force && !isStale(row)) return row;
            return computeDay(day);
        },
        // Days of the inclusive range, up to today, that need a calculation.
        staleDays(start, end) {
            const today = localDayKey(now());
            const last = end < today ? end : today;
            const rows = new Map(store.range(start, last).map(row => [row.day, row]));
            const stale = [];
            for (let day = start; day <= last; day = nextDay(day)) {
                if (isStale(rows.get(day))) stale.push(day);
            }
            return stale;
        }
    };
}

module.exports = {createEnergyDays, localDayKey, isValidDay, dayBounds, COMPLETE_DELAY_MS};
