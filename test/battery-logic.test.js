const assert = require('node:assert/strict');
const test = require('node:test');

const {readSettings, getDeviceActivation} = require('../lib/battery-logic');

const settings = readSettings({zendure_battery_full_soc: 100, zendure_battery_max_charging_power: 800});

function decide(battery, {powerAvailable = true, config = settings} = {}) {
    return getDeviceActivation({battery, powerAvailable}, config);
}

test('settings default to a 100 % full battery, no known maximum charge and a 50 W tolerance', () => {
    assert.deepEqual(readSettings({}), {fullSocPercent: 100, maxChargingPowerW: null, maxChargingToleranceW: 50, ignoreState: false});
    assert.deepEqual(readSettings({zendure_battery_full_soc: 95, zendure_battery_max_charging_power: 1200,
        zendure_battery_max_charging_tolerance: 0}), {fullSocPercent: 95, maxChargingPowerW: 1200, maxChargingToleranceW: 0, ignoreState: false});
});

test('invalid settings fail with a configuration error', () => {
    for (const value of [-1, 101, '100', null, NaN, Infinity]) {
        if (value === null) continue; // null falls back to the default
        assert.throws(() => readSettings({zendure_battery_full_soc: value}), /zendure_battery_full_soc/);
    }
    for (const value of [0, -800, '800', NaN, Infinity]) {
        assert.throws(() => readSettings({zendure_battery_max_charging_power: value}), /zendure_battery_max_charging_power/);
    }
    for (const value of ['true', 1, 0]) {
        assert.throws(() => readSettings({zendure_battery_ignore_state: value}), /zendure_battery_ignore_state/);
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

test('with zendure_battery_ignore_state only the measured power decides charging and discharging', () => {
    const config = readSettings({zendure_battery_full_soc: 100, zendure_battery_max_charging_power: 800,
        zendure_battery_ignore_state: true});
    assert.equal(decide({socPercent: 100, state: 'discharging', dischargingPowerW: 0}, {config}).reason, 'battery-full');
    assert.equal(decide({socPercent: 100, state: 'charging', chargingPowerW: 0}, {config}).reason, 'battery-full');
    assert.equal(decide({socPercent: 50, state: 'standby', dischargingPowerW: 120}, {config}).reason, 'battery-discharging');
    assert.equal(decide({socPercent: 50, state: 'standby', chargingPowerW: 800}, {config}).reason, 'battery-charging-at-max');
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

test('limits reported by Zendure take precedence over the configured ones', () => {
    // Zendure's charge target (90 %) and maximum charge power (2500 W) replace 100 % and 800 W.
    const reported = {chargeTargetPercent: 90, maxChargePowerW: 2500};
    assert.deepEqual(decide({socPercent: 90, state: 'standby', ...reported}), {
        enabled: true, reason: 'battery-full', socPercent: 90, fullSocPercent: 90, maxChargingPowerW: 2500
    });
    assert.equal(decide({socPercent: 89, state: 'standby', ...reported}).reason, 'battery-not-full');
    // 800 W is the configured maximum, but Zendure says 2500 W.
    assert.equal(decide({socPercent: 40, state: 'charging', chargingPowerW: 800, ...reported}).reason, 'battery-charging-below-max');
    assert.equal(decide({socPercent: 40, state: 'charging', chargingPowerW: 2450, ...reported}).reason, 'battery-charging-at-max');
    // They also apply when nothing is configured.
    const unconfigured = {config: readSettings({})};
    assert.equal(decide({socPercent: 90, state: 'standby', ...reported}, unconfigured).reason, 'battery-full');
    assert.equal(decide({socPercent: 40, state: 'charging', chargingPowerW: 2500, ...reported}, unconfigured).reason,
        'battery-charging-at-max');
});

test('each limit falls back to the configuration when Zendure does not report a valid one', () => {
    const onlyTarget = decide({socPercent: 90, state: 'charging', chargingPowerW: 800, chargeTargetPercent: 90});
    assert.equal(onlyTarget.reason, 'battery-charging-at-max'); // maximum power from config
    assert.deepEqual([onlyTarget.fullSocPercent, onlyTarget.maxChargingPowerW], [90, 800]);
    const onlyMax = decide({socPercent: 90, state: 'standby', maxChargePowerW: 2500});
    assert.equal(onlyMax.reason, 'battery-not-full'); // full level from config
    assert.deepEqual([onlyMax.fullSocPercent, onlyMax.maxChargingPowerW], [100, 2500]);
    for (const invalid of [null, undefined, 0, -5, '90', NaN, Infinity]) {
        const decision = decide({socPercent: 40, state: 'standby', chargeTargetPercent: invalid, maxChargePowerW: invalid});
        assert.deepEqual([decision.fullSocPercent, decision.maxChargingPowerW], [100, 800]);
    }
    // Above 100 % is not a valid charge target; any positive wattage is a valid maximum.
    assert.equal(decide({socPercent: 40, state: 'standby', chargeTargetPercent: 101}).fullSocPercent, 100);
});

test('an unavailable battery reports the configured limits', () => {
    const decision = decide({chargeTargetPercent: 90, maxChargePowerW: 2500, socPercent: null});
    assert.equal(decision.reason, 'battery-unavailable');
    assert.deepEqual([decision.fullSocPercent, decision.maxChargingPowerW], [100, 800]);
});
