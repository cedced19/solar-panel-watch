// Integrate each sorted power series independently. Influx omits unavailable
// fields, so network and solar readings need not have matching timestamps.
// Values are W·s converted to kWh; each day's last sample has a 15 s tail.

function prettyNumber(num) {
    return Math.floor(num * 1000) / 1000;
}

function localDayKey(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

function isLocalMidnight(ms) {
    const d = new Date(ms);
    return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

function integrateSeries(points) {
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
                if (ts > prevTs) integrate(day, prevValue, (ts - prevTs) / 1000);
            } else if (isLocalMidnight(ts)) {
                // Preserve the original inclusive midnight boundary: this
                // sample closes the previous day and also opens its own day.
                if (ts > prevTs) integrate(day, prevValue, (ts - prevTs) / 1000);
                setPoint(day, ts, value);
            } else {
                setPoint(day, prevTs, prevValue);
            }
        }
        prevTs = ts;
        prevValue = value;
    }

    if (prevTs !== undefined) setPoint(dayFor(prevTs), prevTs, prevValue);
    for (const day of days.values()) integrate(day, day.lastValue, 15);
    return days;
}

function computeEnergy(network_data, solar_panel_data = []) {
    const networkDays = integrateSeries(network_data);
    if (networkDays.size === 0) return [];
    const solarDays = integrateSeries(solar_panel_data);
    const units = 60 * 60 * 1000;

    return Array.from(networkDays, ([key, day]) => {
        const solarDay = solarDays.get(key);
        const solarEnergy = solarDay ? solarDay.consume + solarDay.introduce : null;
        return {
            start_date: new Date(day.firstT),
            end_date: new Date(day.lastT),
            consumption_on_network: prettyNumber(day.consume / units),
            introduced_on_network: prettyNumber(day.introduce / units),
            solar_panel: solarEnergy === null ? null : prettyNumber(solarEnergy / units),
            house_consumption: solarEnergy === null ? null :
                prettyNumber((day.consume + day.introduce + solarEnergy) / units)
        };
    });
}

module.exports = computeEnergy;
