const assert = require('node:assert/strict');
const test = require('node:test');

const {readSettings, getDeviceActivation} = require('../lib/battery-logic');

const settings = readSettings({zendure_battery_full_soc: 100, zendure_battery_max_charging_power: 800});

function decide(battery, {powerAvailable = true, config = settings} = {}) {
    return getDeviceActivation({battery, powerAvailable}, config);
}

test('settings default to a 100 % full battery, no known maximum charge and a 50 W tolerance', () => {
    assert.deepEqual(readSettings({}), {fullSocPercent: 100, maxChargingPowerW: null, maxChargingToleranceW: 50});
    assert.deepEqual(readSettings({zendure_battery_full_soc: 95, zendure_battery_max_charging_power: 1200,
        zendure_battery_max_charging_tolerance: 0}), {fullSocPercent: 95, maxChargingPowerW: 1200, maxChargingToleranceW: 0});
});

test('invalid settings fail with a configuration error', () => {
    for (const value of [-1, 101, '100', null, NaN, Infinity]) {
        if (value === null) continue; // null falls back to the default
        assert.throws(() => readSettings({zendure_battery_full_soc: value}), /zendure_battery_full_soc/);
    }
    for (const value of [0, -800, '800', NaN, Infinity]) {
        assert.throws(() => readSettings({zendure_battery_max_charging_power: value}), /zendure_battery_max_charging_power/);
    }
    for (const value of [-1, '50', NaN]) {
        assert.throws(() => readSettings({zendure_battery_max_charging_tolerance: value}), /zendure_battery_max_charging_tolerance/);
    }
});

test('a discharging battery never activates devices, even when full', () => {
    for (const battery of [
        {socPercent: 100, state: 'discharging', chargingPowerW: 0, dischargingPowerW: 300},
        {socPercent: 100, state: 'discharging'},
        {socPercent: 100, state: 'standby', chargingPowerW: 0, dischargingPowerW: 20},
        // Contradictory readings resolve to "do not activate".
        {socPercent: 60, state: 'charging', chargingPowerW: 800, dischargingPowerW: 10}
    ]) {
        const decision = decide(battery);
        assert.equal(decision.enabled, false);
        assert.equal(decision.reason, 'battery-discharging');
    }
});

test('a charging battery activates devices only at its maximum charging power', () => {
    assert.deepEqual(decide({socPercent: 40, state: 'charging', chargingPowerW: 800, dischargingPowerW: 0}), {
        enabled: true, reason: 'battery-charging-at-max', socPercent: 40, fullSocPercent: 100, maxChargingPowerW: 800
    });
    // Within the default 50 W tolerance.
    assert.equal(decide({socPercent: 40, state: 'charging', chargingPowerW: 750}).reason, 'battery-charging-at-max');
    for (const battery of [
        {socPercent: 40, state: 'charging', chargingPowerW: 749},
        {socPercent: 99, state: 'charging', chargingPowerW: 100},
        {socPercent: 40, state: 'charging'}, // charging power unknown
        {socPercent: 40, state: 'standby', chargingPowerW: 300} // flow measured despite the state
    ]) {
        const decision = decide(battery);
        assert.equal(decision.enabled, false);
        assert.equal(decision.reason, 'battery-charging-below-max');
    }
});

test('without a configured maximum charging power, charging never activates devices', () => {
    const decision = decide({socPercent: 40, state: 'charging', chargingPowerW: 5000}, {config: readSettings({})});
    assert.equal(decision.reason, 'battery-charging-below-max');
    assert.equal(decision.maxChargingPowerW, null);
});

test('an idle battery activates devices only when full', () => {
    assert.deepEqual(decide({socPercent: 100, state: 'standby', chargingPowerW: 0, dischargingPowerW: 0}), {
        enabled: true, reason: 'battery-full', socPercent: 100, fullSocPercent: 100, maxChargingPowerW: 800
    });
    assert.equal(decide({socPercent: 95, state: 'standby'},
        {config: readSettings({zendure_battery_full_soc: 95})}).reason, 'battery-full');
    for (const battery of [{socPercent: 99.9, state: 'standby'}, {socPercent: 0}]) {
        const decision = decide(battery);
        assert.equal(decision.enabled, false);
        assert.equal(decision.reason, 'battery-not-full');
    }
});

test('unavailable battery or house power never activates devices', () => {
    for (const battery of [null, undefined, {}, {socPercent: '90'}, {socPercent: NaN}, {socPercent: -1}, {socPercent: 101}]) {
        assert.deepEqual(decide(battery), {
            enabled: false, reason: 'battery-unavailable', socPercent: null, fullSocPercent: 100, maxChargingPowerW: 800
        });
    }
    const decision = decide({socPercent: 100, state: 'standby'}, {powerAvailable: false});
    assert.equal(decision.enabled, false);
    assert.equal(decision.reason, 'power-unavailable');
    assert.equal(decision.socPercent, 100);
});
