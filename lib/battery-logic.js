'use strict';

// Decides whether surplus solar power may be sent to the controlled devices.
// The battery comes first: devices only receive power the battery cannot take.
//
//   if battery discharging:          do not activate
//   elif battery charging:
//       if charging power at max:    activate
//       else:                        do not activate
//   elif battery full:               activate
//   else:                            do not activate
//
// Missing/stale battery data or unavailable house power never activates devices.
// Forced devices are decided before this rule and ignore it. For the other devices
// the decision only uses the battery's own readings: it is checked before their
// surplus logic, so the devices never take part in it.

const DEFAULT_FULL_SOC_PERCENT = 100;
const DEFAULT_MAX_CHARGING_TOLERANCE_W = 50;

const ACTIVATING_REASONS = new Set(['battery-charging-at-max', 'battery-full']);

function isPercent(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isPower(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Reads and validates the battery settings from config.json:
 *   zendure_battery_full_soc               SOC (%) from which the battery counts as full; default 100.
 *   zendure_battery_max_charging_power     Maximum charging power (W); unset means "never at max".
 *   zendure_battery_max_charging_tolerance Margin (W) below the maximum still counted as max; default 50.
 */
function readSettings(config) {
    const fullSocPercent = config.zendure_battery_full_soc ?? DEFAULT_FULL_SOC_PERCENT;
    if (!isPercent(fullSocPercent)) {
        throw new Error('zendure_battery_full_soc must be a number between 0 and 100.');
    }
    const maxChargingPowerW = config.zendure_battery_max_charging_power ?? null;
    if (maxChargingPowerW !== null && !(isPower(maxChargingPowerW) && maxChargingPowerW > 0)) {
        throw new Error('zendure_battery_max_charging_power must be a positive number of watts.');
    }
    const maxChargingToleranceW = config.zendure_battery_max_charging_tolerance ?? DEFAULT_MAX_CHARGING_TOLERANCE_W;
    if (!isPower(maxChargingToleranceW)) {
        throw new Error('zendure_battery_max_charging_tolerance must be a nonnegative number of watts.');
    }
    return {fullSocPercent, maxChargingPowerW, maxChargingToleranceW};
}

// Either the reported state or a measured flow is enough; discharging is checked
// first, so a contradictory reading never activates devices.
function isDischarging(battery) {
    return battery.state === 'discharging' || (isPower(battery.dischargingPowerW) && battery.dischargingPowerW > 0);
}

function isCharging(battery) {
    return battery.state === 'charging' || (isPower(battery.chargingPowerW) && battery.chargingPowerW > 0);
}

// Compares the charging power reported by Zendure with the battery's maximum.
function isChargingAtMax(battery, settings) {
    if (settings.maxChargingPowerW === null || !isPower(battery.chargingPowerW)) return false;
    return battery.chargingPowerW >= settings.maxChargingPowerW - settings.maxChargingToleranceW;
}

function isFull(battery, settings) {
    return battery.socPercent >= settings.fullSocPercent;
}

function batteryReason(battery, settings) {
    if (isDischarging(battery)) {
        return 'battery-discharging';
    } else if (isCharging(battery)) {
        return isChargingAtMax(battery, settings) ? 'battery-charging-at-max' : 'battery-charging-below-max';
    } else if (isFull(battery, settings)) {
        return 'battery-full';
    } else {
        return 'battery-not-full';
    }
}

/**
 * battery:        latest fresh Zendure battery reading, or null when unavailable/stale.
 * powerAvailable: whether the house meter currently supplies valid power.
 */
function getDeviceActivation({battery, powerAvailable}, settings) {
    const reading = battery && isPercent(battery.socPercent) ? battery : null;
    let reason;
    if (!reading) {
        reason = 'battery-unavailable';
    } else if (!powerAvailable) {
        reason = 'power-unavailable';
    } else {
        reason = batteryReason(reading, settings);
    }
    return {
        enabled: ACTIVATING_REASONS.has(reason),
        reason,
        socPercent: reading ? reading.socPercent : null,
        fullSocPercent: settings.fullSocPercent,
        maxChargingPowerW: settings.maxChargingPowerW
    };
}

module.exports = {readSettings, getDeviceActivation};
