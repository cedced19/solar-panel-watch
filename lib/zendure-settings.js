'use strict';

// Settings and diagnostics of a SolarFlow report, for display only.
// Property definitions: https://github.com/Zendure/zenSDK/blob/main/docs/en_properties.md

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function scaled(value, divisor) {
    const number = finiteNumber(value);
    return number === null ? null : Math.round(number / divisor * 100) / 100;
}

// Temperatures are reported in tenths of a Kelvin.
function celsius(value) {
    const number = finiteNumber(value);
    return number === null ? null : Math.round((number - 2731) / 10 * 10) / 10;
}

function name(names, value) {
    return Number.isInteger(value) ? names[value] ?? null : null;
}

function parsePack(pack) {
    return {
        serial: typeof pack.sn === 'string' ? pack.sn : null,
        socPercent: finiteNumber(pack.socLevel),
        state: name(['standby', 'charging', 'discharging'], pack.state),
        powerW: finiteNumber(pack.power),
        temperatureC: celsius(pack.maxTemp),
        voltageV: scaled(pack.totalVol, 100),
        maxCellVoltageV: scaled(pack.maxVol, 100),
        minCellVoltageV: scaled(pack.minVol, 100),
        softwareVersion: finiteNumber(pack.softVersion)
    };
}

/**
 * Extracts the battery settings from a /properties/report body.
 * Missing or invalid fields become null; the report is never modified.
 */
function parseBatterySettings(report) {
    const properties = report && typeof report === 'object' && !Array.isArray(report) ? report.properties ?? report : null;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
        throw new Error('Zendure returned an invalid properties report.');
    }
    const packs = report.packData ?? properties.packData;
    return {
        product: typeof report.product === 'string' ? report.product : null,
        serial: report.sn ?? report.snNumber ?? null,
        limits: {
            // socSet and minSoc are reported in tenths of a percent.
            chargeTargetPercent: scaled(properties.socSet, 10),
            minimumSocPercent: scaled(properties.minSoc, 10),
            gridChargeInputLimitW: finiteNumber(properties.inputLimit),
            homeOutputLimitW: finiteNumber(properties.outputLimit),
            maxChargePowerW: finiteNumber(properties.chargeMaxLimit),
            inverterMaxPowerW: finiteNumber(properties.inverseMaxPower)
        },
        modes: {
            acMode: finiteNumber(properties.acMode),
            acModeName: name([null, 'AC input', 'AC output'], properties.acMode),
            smartMode: finiteNumber(properties.smartMode),
            gridStandard: finiteNumber(properties.gridStandard),
            gridReverse: finiteNumber(properties.gridReverse),
            offGridMode: finiteNumber(properties.gridOffMode),
            lampSwitch: finiteNumber(properties.lampSwitch)
        },
        solar: {
            inputPowerW: finiteNumber(properties.solarInputPower),
            input1W: finiteNumber(properties.solarPower1),
            input2W: finiteNumber(properties.solarPower2),
            pvStatus: finiteNumber(properties.pvStatus)
        },
        status: {
            socPercent: finiteNumber(properties.electricLevel),
            socLimit: name(['normal', 'full', 'empty'], properties.socLimit),
            remainingOutputMinutes: finiteNumber(properties.remainOutTime),
            packCount: finiteNumber(properties.packNum),
            inverterTemperatureC: celsius(properties.hyperTmp),
            batteryVoltageV: scaled(properties.BatVolt, 100),
            wifiRssiDbm: finiteNumber(properties.rssi),
            faultLevel: finiteNumber(properties.faultLevel),
            hasError: finiteNumber(properties.is_error) === null ? null : properties.is_error !== 0
        },
        packs: Array.isArray(packs) ? packs.filter(pack => pack && typeof pack === 'object').map(parsePack) : []
    };
}

module.exports = {parseBatterySettings};
