// Integrate each sorted power series independently. Influx omits unavailable
// fields, so network, solar and battery readings need not have matching timestamps.
// Values are W·s converted to kWh; each day's last sample has a 15 s tail.

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

// seconds(from, to) gives the part of each interval to count (all of it by default).
function integrateSeries(points, seconds = allSeconds) {
    const days = new Map();

    function dayFor(ts) {
        const key = localDayKey(ts);
        if (!days.has(key)) {
            days.set(key, {consume: 0, introduce: 0, firstT: undefined, lastT: undefined, lastValue: 0});
        }
        return days.get(key);
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

    let prevTs;
    let prevValue;
    for (const point of points) {
        const ts = Date.parse(point._time);
        const value = point._value;
        if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;

        if (prevTs !== undefined) {
            const day = dayFor(prevTs);
            if (localDayKey(ts) === localDayKey(prevTs)) {
                setPoint(day, prevTs, prevValue);
                if (ts > prevTs) integrate(day, prevValue, seconds(prevTs, ts));
            } else if (isLocalMidnight(ts)) {
                // Preserve the original inclusive midnight boundary: this
                // sample closes the previous day and also opens its own day.
                if (ts > prevTs) integrate(day, prevValue, seconds(prevTs, ts));
                setPoint(day, ts, value);
            } else {
                setPoint(day, prevTs, prevValue);
            }
        }
        prevTs = ts;
        prevValue = value;
    }

    if (prevTs !== undefined) setPoint(dayFor(prevTs), prevTs, prevValue);
    for (const day of days.values()) integrate(day, day.lastValue, seconds(day.lastT, day.lastT + 15000));
    return days;
}

function integrateBatterySeries(points, field, seconds) {
    const availablePoints = [];
    const unavailableDays = new Set();
    let prevTs;

    for (const point of points) {
        const ts = Date.parse(point._time);
        if (!Number.isFinite(ts)) continue;
        const value = point[field];
        if (Number.isFinite(value) && value >= 0) {
            availablePoints.push({_time: point._time, _value: value});
        } else {
            // SOC-only and incomplete readings do not establish zero battery
            // power. Preserve that uncertainty instead of bridging the gap.
            unavailableDays.add(localDayKey(ts));
            if (prevTs !== undefined && isLocalMidnight(ts)) {
                unavailableDays.add(localDayKey(prevTs));
            }
        }
        prevTs = ts;
    }

    const days = integrateSeries(availablePoints, seconds);
    for (const key of unavailableDays) days.delete(key);
    return days;
}

function computeEnergy(network_data, solar_panel_data = [], battery_data = []) {
    const networkDays = integrateSeries(network_data);
    if (networkDays.size === 0) return [];
    const solarDays = integrateSeries(solar_panel_data);
    const batteryDischargingDays = integrateBatterySeries(battery_data, 'packInputPower');
    const batteryChargingDays = integrateBatterySeries(battery_data, 'outputPackPower');
    const nightChargingDays = integrateBatterySeries(battery_data, 'outputPackPower', nightSeconds);
    const units = 60 * 60 * 1000;

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
                prettyNumber((day.consume + day.introduce + solarEnergy + batteryAdjustment) / units)
        };
    });
}

module.exports = computeEnergy;
