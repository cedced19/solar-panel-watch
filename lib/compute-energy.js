// Integrate each sorted power series independently. The history omits unavailable
// fields, so network, solar and battery readings need not have matching timestamps.
// Values are W·s converted to kWh; each day's last sample has a 15 s tail.
//
// A reading is held until the next one, but for at most MAX_HOLD_MS: the rest
// of a longer gap is missing, not integrated. Each series reports its coverage
// per day, the share of the day's window (percent) that readings were held over.

// Longer than a few missed 1 s readings, shorter than any real outage.
const MAX_HOLD_MS = 30 * 1000;
const TAIL_MS = 15 * 1000;

function prettyNumber(num) {
    return Math.floor(num * 1000) / 1000;
}

function localDayKey(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

// Battery charging between these local hours cannot come from the solar
// panels, so it is counted as charging from the grid.
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 6;

const allSeconds = (from, to) => (to - from) / 1000;

// Seconds of [from, to) (ms) that fall between NIGHT_START_HOUR and NIGHT_END_HOUR local time.
function nightSeconds(from, to) {
    let total = 0;
    for (let start = from; start < to;) {
        const date = new Date(start);
        const at = hour => new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour).getTime();
        const morning = at(NIGHT_END_HOUR);
        const evening = at(NIGHT_START_HOUR);
        const end = Math.min(to, start < morning ? morning : start < evening ? evening : at(24 + NIGHT_END_HOUR));
        if (start < morning || start >= evening) total += end - start;
        start = end;
    }
    return total / 1000;
}

function isLocalMidnight(ms) {
    const d = new Date(ms);
    return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

function newDay(ts) {
    const d = new Date(ts);
    return {
        consume: 0, introduce: 0, firstT: undefined, lastT: undefined, lastValue: 0,
        start: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
        end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(),
        heldMs: 0, tailMs: 0
    };
}

function setPoint(day, ts, value) {
    if (day.firstT === undefined) day.firstT = ts;
    day.lastT = ts;
    day.lastValue = value;
}

function integrate(day, value, seconds) {
    if (value > 0) day.consume += value * seconds;
    else day.introduce += value * seconds;
}

// Integrates one sorted series reading by reading (ms timestamps), per local
// day, keeping only the running sums. seconds(from, to) gives the part of each
// interval to count (all of it by default).
function createIntegrator(seconds = allSeconds, maxHoldMs = MAX_HOLD_MS) {
    const days = new Map();
    // The day of the reading before, to tell the same day without building a date.
    let current = null;
    let prevTs;
    let prevValue;

    function dayFor(ts) {
        if (current && ts >= current.start && ts < current.end) return current;
        const key = localDayKey(ts);
        let day = days.get(key);
        if (!day) {
            day = newDay(ts);
            days.set(key, day);
        }
        current = day;
        return day;
    }

    // Hold value over [from, to), but no longer than maxHoldMs.
    function hold(day, value, from, to) {
        const end = Math.min(to, from + maxHoldMs);
        if (value !== 0) integrate(day, value, seconds(from, end));
        day.heldMs += end - from;
    }

    return {
        add(ts, value) {
            if (!Number.isFinite(ts) || !Number.isFinite(value)) return;
            if (prevTs !== undefined) {
                const day = dayFor(prevTs);
                if (ts >= day.start && ts < day.end) {
                    setPoint(day, prevTs, prevValue);
                    if (ts > prevTs) hold(day, prevValue, prevTs, ts);
                } else if (isLocalMidnight(ts)) {
                    // Preserve the original inclusive midnight boundary: this
                    // sample closes the previous day and also opens its own day.
                    if (ts > prevTs) hold(day, prevValue, prevTs, ts);
                    setPoint(day, ts, value);
                } else {
                    setPoint(day, prevTs, prevValue);
                }
            }
            prevTs = ts;
            prevValue = value;
        },

        // The days integrated so far, with the tail of each day's last reading.
        // The integrator keeps accepting readings afterwards.
        finish() {
            const done = new Map();
            for (const [key, day] of days) done.set(key, {...day});
            if (prevTs !== undefined) {
                const key = localDayKey(prevTs);
                if (!done.has(key)) done.set(key, newDay(prevTs));
                setPoint(done.get(key), prevTs, prevValue);
            }
            // The last reading of each day is held a little longer; coverage counts
            // that tail only as far as the period it is asked for (see coverage()).
            const tailMs = Math.min(TAIL_MS, maxHoldMs);
            for (const day of done.values()) {
                integrate(day, day.lastValue, seconds(day.lastT, day.lastT + tailMs));
                day.tailMs = tailMs;
            }
            return done;
        }
    };
}

// Percent (one decimal) of the day's window, between from and to, that the
// series held a reading over; null when the series has no data that day.
function coverage(day, from, to) {
    if (!day) return null;
    const begin = Math.max(day.start, from);
    const end = Math.min(day.end, to);
    if (!(end > begin)) return null;
    const tailMs = Math.max(0, Math.min(day.lastT + day.tailMs, end) - Math.max(day.lastT, begin));
    return Math.round(Math.min(1, (day.heldMs + tailMs) / (end - begin)) * 1000) / 10;
}

const parseTime = time => typeof time === 'number' ? time : Date.parse(time);

const isPercent = value => Number.isFinite(value) && value >= 0 && value <= 100;

// The highest battery level (percent) of each local day, from readings fed one
// at a time. A level is a state, not a flow: it is not held between readings.
function createPeakLevels() {
    const days = new Map();
    // The day of the reading before, to tell the same day without building a date.
    let current = null;
    return {
        add(ts, level) {
            if (!Number.isFinite(ts) || !isPercent(level)) return;
            if (!current || ts < current.start || ts >= current.end) {
                const key = localDayKey(ts);
                current = days.get(key);
                if (!current) {
                    const {start, end} = newDay(ts);
                    current = {start, end, peak: level};
                    days.set(key, current);
                }
            }
            if (level > current.peak) current.peak = level;
        },
        // Percent with one decimal; null for a day without any valid level.
        peak(key) {
            const day = days.get(key);
            return day ? Math.round(day.peak * 10) / 10 : null;
        }
    };
}

// Energy of each local day from readings fed one at a time, in time order for
// each source (grid, solar, battery), so a day of 1 s readings needs no array.
// time is an ISO string or ms. A battery row is one timestamp with its two
// power fields; a field that is missing or invalid (not a finite value of 0 or
// more) makes that direction unavailable for the whole day, as an SOC-only row
// does not establish zero power.
// options.maxHoldMs: how long a reading is held (default MAX_HOLD_MS).
function createEnergyAccumulator({maxHoldMs = MAX_HOLD_MS} = {}) {
    const network = createIntegrator(allSeconds, maxHoldMs);
    const solar = createIntegrator(allSeconds, maxHoldMs);
    const discharging = createIntegrator(allSeconds, maxHoldMs);
    const charging = createIntegrator(allSeconds, maxHoldMs);
    const nightCharging = createIntegrator(nightSeconds, maxHoldMs);
    const peakLevels = createPeakLevels();
    const unavailable = {discharging: new Set(), charging: new Set()};
    let prevBatteryTs;

    const isPower = value => Number.isFinite(value) && value >= 0;

    function markUnavailable(days, ts) {
        days.add(localDayKey(ts));
        if (prevBatteryTs !== undefined && isLocalMidnight(ts)) days.add(localDayKey(prevBatteryTs));
    }

    const withoutDays = (days, keys) => {
        for (const key of keys) days.delete(key);
        return days;
    };

    return {
        addNetwork(time, value) {
            network.add(parseTime(time), value);
        },

        addSolar(time, value) {
            solar.add(parseTime(time), value);
        },

        // socPercent is the battery level of the row; it only feeds battery_max_soc.
        addBattery(time, packInputPower, outputPackPower, socPercent) {
            const ts = parseTime(time);
            if (!Number.isFinite(ts)) return;
            peakLevels.add(ts, socPercent);
            if (isPower(packInputPower)) discharging.add(ts, packInputPower);
            else markUnavailable(unavailable.discharging, ts);
            if (isPower(outputPackPower)) {
                charging.add(ts, outputPackPower);
                nightCharging.add(ts, outputPackPower);
            } else {
                markUnavailable(unavailable.charging, ts);
            }
            prevBatteryTs = ts;
        },

        // options.from / options.to (ms): the period the readings should cover,
        // by default from the first grid reading to the end of the last one.
        result(options = {}) {
            const networkDays = network.finish();
            if (networkDays.size === 0) return [];
            const solarDays = solar.finish();
            const batteryDischargingDays = withoutDays(discharging.finish(), unavailable.discharging);
            const batteryChargingDays = withoutDays(charging.finish(), unavailable.charging);
            const nightChargingDays = withoutDays(nightCharging.finish(), unavailable.charging);
            const units = 60 * 60 * 1000;
            const networkRuns = Array.from(networkDays.values());
            const from = options.from ?? Math.min(...networkRuns.map(day => day.firstT));
            const to = options.to ?? Math.max(...networkRuns.map(day => day.lastT)) + Math.min(TAIL_MS, maxHoldMs);

            return Array.from(networkDays, ([key, day]) => {
                const solarDay = solarDays.get(key);
                const solarEnergy = solarDay ? solarDay.consume + solarDay.introduce : null;
                const batteryDischargingDay = batteryDischargingDays.get(key);
                const batteryDischargingEnergy = batteryDischargingDay ? batteryDischargingDay.consume : null;
                const batteryChargingDay = batteryChargingDays.get(key);
                const batteryChargingEnergy = batteryChargingDay ? batteryChargingDay.consume : null;
                const nightChargingDay = nightChargingDays.get(key);
                // Older history may contain only SOC or one power direction. Apply
                // the battery adjustment only when both directions are available;
                // otherwise retain the usable grid-plus-solar household estimate.
                const batteryAdjustment = batteryDischargingEnergy === null || batteryChargingEnergy === null ? 0 :
                    batteryDischargingEnergy - batteryChargingEnergy;
                const batteryCoverages = [batteryDischargingDay, batteryChargingDay]
                    .map(batteryDay => coverage(batteryDay, from, to)).filter(value => value !== null);
                return {
                    start_date: new Date(day.firstT),
                    end_date: new Date(day.lastT),
                    consumption_on_network: prettyNumber(day.consume / units),
                    introduced_on_network: prettyNumber(day.introduce / units),
                    solar_panel: solarEnergy === null ? null : prettyNumber(solarEnergy / units),
                    battery_discharging: batteryDischargingEnergy === null ? null : prettyNumber(batteryDischargingEnergy / units),
                    battery_charging: batteryChargingEnergy === null ? null : prettyNumber(batteryChargingEnergy / units),
                    charging_energy_from_network: nightChargingDay ? prettyNumber(nightChargingDay.consume / units) : null,
                    house_consumption: solarEnergy === null ? null :
                        prettyNumber((day.consume + day.introduce + solarEnergy + batteryAdjustment) / units),
                    coverage_network: coverage(day, from, to),
                    coverage_solar: coverage(solarDay, from, to),
                    coverage_battery: batteryCoverages.length ? Math.min(...batteryCoverages) : null,
                    battery_max_soc: peakLevels.peak(key)
                };
            });
        }
    };
}

// The same from arrays of {_time, _value} points (grid, solar) and battery rows
// ({_time, _value: socPercent, packInputPower, outputPackPower}). options as
// createEnergyAccumulator and result().
function computeEnergy(network_data, solar_panel_data = [], battery_data = [], options = {}) {
    const accumulator = createEnergyAccumulator(options);
    for (const point of network_data) accumulator.addNetwork(point._time, point._value);
    for (const point of solar_panel_data) accumulator.addSolar(point._time, point._value);
    for (const row of battery_data) accumulator.addBattery(row._time, row.packInputPower, row.outputPackPower, row._value);
    return accumulator.result(options);
}

// Energy (kWh) used by all the devices over [start, stop). A device's power
// holds until its next value, starting from its last value before start
// (devices only write their power when it changes).
function devicesEnergy(powerByDevice, start, stop) {
    const from = new Date(start).getTime();
    const to = new Date(stop).getTime();
    let total = 0;
    for (const points of Object.values(powerByDevice)) {
        let power = 0;
        let since = from;
        for (const point of points) {
            const ts = Date.parse(point._time);
            if (!Number.isFinite(ts) || !Number.isFinite(point._value)) continue;
            if (ts >= to) break;
            if (ts > since) {
                total += Math.max(0, power) * (ts - since) / 1000;
                since = ts;
            }
            power = point._value;
        }
        if (to > since) total += Math.max(0, power) * (to - since) / 1000;
    }
    return prettyNumber(total / (60 * 60 * 1000));
}

module.exports = computeEnergy;
module.exports.devicesEnergy = devicesEnergy;
module.exports.createEnergyAccumulator = createEnergyAccumulator;
module.exports.MAX_HOLD_MS = MAX_HOLD_MS;
