(function () {
    const roundEnergy = value => Math.round(value * 1000) / 1000;
    const hasBatteryData = entry =>
        [entry.battery_discharging, entry.battery_charging]
            .every(value => Number.isFinite(value) && value >= 0);

    // Earlier saved calculations left the total unavailable when battery
    // readings were missing. Recover the grid + solar total for display while
    // keeping the recorded battery values and saved history unchanged.
    function normalizeEntry(entry) {
        if (Number.isFinite(entry.house_consumption)) return entry;
        const gridAndSolar = [entry.consumption_on_network,
            entry.introduced_on_network, entry.solar_panel];
        if (hasBatteryData(entry) || !gridAndSolar.every(Number.isFinite)) return entry;
        return {
            ...entry,
            house_consumption: roundEnergy(gridAndSolar.reduce((sum, value) => sum + value, 0))
        };
    }

    function savedEnergy(entry) {
        const row = normalizeEntry(entry);
        return Number.isFinite(row.house_consumption) && Number.isFinite(row.consumption_on_network) ?
            roundEnergy(row.house_consumption - row.consumption_on_network) : null;
    }

    window.energyConsumption = {normalizeEntry, savedEnergy, roundEnergy, hasBatteryData};
})();
