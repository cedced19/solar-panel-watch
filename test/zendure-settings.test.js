'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {parseBatterySettings} = require('../lib/zendure-settings');

const report = {
    sn: 'ANACVCDLP283458',
    product: 'solarFlow3000MixAC+',
    properties: {
        socSet: 950, minSoc: 100, inputLimit: 0, outputLimit: 0, chargeMaxLimit: 2500, inverseMaxPower: 2000,
        acMode: 2, smartMode: 1, solarInputPower: 0, solarPower1: 0, solarPower2: 0, electricLevel: 10,
        socLimit: 2, remainOutTime: 9870, packNum: 1, hyperTmp: 3081, BatVolt: 2516, rssi: -40, is_error: 0
    },
    packData: [{sn: 'BEAAVCDLA283460', socLevel: 10, state: 2, power: 5, maxTemp: 2960, totalVol: 2512}]
};

test('converts tenths of percent, Kelvin and centivolts', () => {
    const settings = parseBatterySettings(report);
    assert.equal(settings.limits.chargeTargetPercent, 95);
    assert.equal(settings.limits.minimumSocPercent, 10);
    assert.equal(settings.limits.maxChargePowerW, 2500);
    assert.equal(settings.modes.acModeName, 'AC output');
    assert.equal(settings.status.inverterTemperatureC, 35);
    assert.equal(settings.status.batteryVoltageV, 25.16);
    assert.equal(settings.status.socLimit, 'empty');
    assert.equal(settings.status.hasError, false);
    assert.deepEqual(settings.packs[0], {
        serial: 'BEAAVCDLA283460', socPercent: 10, state: 'discharging', powerW: 5, temperatureC: 22.9,
        voltageV: 25.12, maxCellVoltageV: null, minCellVoltageV: null, softwareVersion: null
    });
});

test('missing fields are null and invalid reports throw', () => {
    assert.equal(parseBatterySettings({properties: {}}).limits.chargeTargetPercent, null);
    assert.throws(() => parseBatterySettings(null));
});
