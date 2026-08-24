// Single-pass daily energy computation for the network (power1) and solar
// panel (power2) series. Consumes the raw point arrays returned by influx-lib
// (`[{_time, _value}]`) and aggregates each series per local calendar day in a
// single pass, avoiding the repeated per-day filtering and object allocations
// of the previous implementation.
//
// Units and per-day output contract are preserved from the original (see
// energy.ejs): sums are W·s converted to kWh (dividing by 60*60*1000), and the
// final sample of each day contributes a fixed 15 s tail.

function prettyNumber(num) {
    return Math.floor(num * 1000) / 1000;
}

function localDayKey(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

// A sample exactly on the local-midnight boundary is treated by the original
// implementation as belonging to BOTH neighbouring days (its filter is
// [midnight, nextMidnight] inclusive). Replicate that here.
function isLocalMidnight(ms) {
    const d = new Date(ms);
    return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

function computeEnergy(network_data, solar_panel_data) {
    const n = network_data.length;
    if (n === 0) return [];

    const days = [];
    const byKey = new Map();

    function dayFor(key) {
        let day = byKey.get(key);
        if (!day) {
            day = { key, consume: 0, introduce: 0, solar: 0, house: 0, firstT: undefined, lastT: undefined, lastNetV: 0, lastSolV: 0 };
            byKey.set(key, day);
            days.push(day);
        }
        return day;
    }

    function setPoint(day, ts, net, sol) {
        if (day.firstT === undefined) day.firstT = ts;
        day.lastT = ts;
        day.lastNetV = net;
        day.lastSolV = sol;
    }

    let prevTs = Date.parse(network_data[0]._time);
    let prevNet = network_data[0]._value;
    let prevSol = solar_panel_data[0]._value;

    for (let i = 1; i < n; i++) {
        const ts = Date.parse(network_data[i]._time);
        const net = network_data[i]._value;
        const sol = solar_panel_data[i]._value;
        const day = dayFor(localDayKey(prevTs));

        if (localDayKey(ts) === localDayKey(prevTs)) {
            // same day: integrate the segment [prevTs, ts) valued by prevTs
            const d = (ts - prevTs) / 1000;
            setPoint(day, prevTs, prevNet, prevSol);
            if (d > 0) {
                if (prevNet > 0) day.consume += prevNet * d;
                else day.introduce += prevNet * d;
                day.solar += prevSol * d;
                day.house += (prevNet + prevSol) * d;
            }
        } else if (isLocalMidnight(ts)) {
            // Boundary sample (exactly local midnight): it belongs to BOTH the
            // previous day (as its tail) and the next one. The gap leading up to
            // it is still inside the previous day's window, so integrate it.
            const d = (ts - prevTs) / 1000;
            if (d > 0) {
                if (prevNet > 0) day.consume += prevNet * d;
                else day.introduce += prevNet * d;
                day.solar += prevSol * d;
                day.house += (prevNet + prevSol) * d;
            }
            setPoint(day, ts, net, sol);
            prevTs = ts;
            prevNet = net;
            prevSol = sol;
            continue;
        } else {
            // normal day change: previous sample closes its day (15 s tail)
            setPoint(day, prevTs, prevNet, prevSol);
        }

        prevTs = ts;
        prevNet = net;
        prevSol = sol;
    }

    // record the final sample in its own day
    {
        const day = dayFor(localDayKey(prevTs));
        setPoint(day, prevTs, prevNet, prevSol);
    }

    // apply the fixed 15 s tail to the last sample of each day
    for (let i = 0; i < days.length; i++) {
        const day = days[i];
        if (day.lastNetV > 0) day.consume += day.lastNetV * 15;
        else day.introduce += day.lastNetV * 15;
        day.solar += day.lastSolV * 15;
        day.house += (day.lastNetV + day.lastSolV) * 15;
    }

    return days.map(function (day) {
        return {
            start_date: new Date(day.firstT),
            end_date: new Date(day.lastT),
            consumption_on_network: prettyNumber(day.consume / (60 * 60 * 1000)),
            introduced_on_network: prettyNumber(day.introduce / (60 * 60 * 1000)),
            solar_panel: prettyNumber(day.solar / (60 * 60 * 1000)),
            house_consumption: prettyNumber(day.house / (60 * 60 * 1000))
        };
    });
}

module.exports = computeEnergy;