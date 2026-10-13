function validBatteryPower(value) {
    return Number.isFinite(value) && value >= 0;
}

// Meter and battery polls run at different cadences. Aggregate windows match
// exactly; raw readings use only preceding samples within their freshness limit.
function computeConsumptionPower(data, {aggregated = false, powerMaxAgeMs = 30000, batteryMaxAgeMs = 23000} = {}) {
    const sorted = points => points.filter(point => Number.isFinite(Date.parse(point._time)))
        .slice().sort((a, b) => Date.parse(a._time) - Date.parse(b._time));
    const power1 = sorted(data.power1);
    const power2 = sorted(data.power2);
    const battery = sorted(data.battery);
    const batterySeries = field => battery.map(point => ({
        _time: point._time, _value: validBatteryPower(point[field]) ? point[field] : null
    }));

    function reader(points, maxAgeMs) {
        let index = -1;
        return time => {
            while (index + 1 < points.length && Date.parse(points[index + 1]._time) <= time) index++;
            if (index < 0) return null;
            const age = time - Date.parse(points[index]._time);
            return age <= (aggregated ? 0 : maxAgeMs) ? points[index] : null;
        };
    }

    const solarAt = reader(power2, powerMaxAgeMs);
    const batteryAt = reader(battery, batteryMaxAgeMs);
    return {
        power1,
        power2,
        battery_discharging: batterySeries('packInputPower'),
        battery_charging: batterySeries('outputPackPower'),
        house_consumption: power1.map(point => {
            const time = Date.parse(point._time);
            const solar = solarAt(time);
            const pack = batteryAt(time);
            const available = Number.isFinite(point._value) && solar && Number.isFinite(solar._value) &&
                pack && validBatteryPower(pack.packInputPower) && validBatteryPower(pack.outputPackPower);
            return {
                _time: point._time,
                _value: available ? point._value + solar._value + pack.packInputPower - pack.outputPackPower : null
            };
        })
    };
}

module.exports = computeConsumptionPower;
