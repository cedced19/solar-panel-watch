# Battery-first device activation

Updated on 15 October 2026.

The Zendure battery now takes priority over the controlled devices. Devices
only get surplus power that the battery cannot take. Before this change,
devices could run whenever the battery charge was above
`zendure_battery_min_soc`.

## Rule

The rule is in [`lib/battery-logic.js`](lib/battery-logic.js), written as a
short `if / else if` chain:

```
if battery discharging:          do not activate
elif battery charging:
    if charging power at max:    activate
    else:                        do not activate
elif battery full:               activate
else:                            do not activate
```

Devices also stay off when battery data is missing, invalid or stale, or when
house power is unavailable. These checks run before the rule.

How each condition is read from the Zendure report:

| Condition | Source |
| --- | --- |
| Discharging | `state === 'discharging'` or `dischargingPowerW` (`packInputPower`) > 0 |
| Charging | `state === 'charging'` or `chargingPowerW` (`outputPackPower`) > 0 |
| Charging power at max | `chargingPowerW` + power of running devices ≥ `zendure_battery_max_charging_power` − tolerance |
| Full | `socPercent` ≥ `zendure_battery_full_soc` |

The discharging check runs first. If a reading claims both charging and
discharging, devices stay off.

### Why running devices count toward charging power

With the smart meter, the battery charges only from power that would otherwise
go to the grid. When a device turns on, it takes part of that surplus and the
battery's charging power drops. Without a correction, the next decision would
see "charging below max" and turn the device off. The battery would then go
back to maximum and the device would turn on again, over and over. Adding the
devices' draw back answers the real question: would the battery charge at its
maximum if the devices were off? The main control loop already counts device
power the same way when it calculates available surplus.

If the devices take more than the surplus, the battery starts discharging and
the first rule turns them off.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `zendure_battery_full_soc` | `100` | SOC (%) from which an idle battery counts as full. |
| `zendure_battery_max_charging_power` | unset | Maximum charging power in watts. If unset, a charging battery never counts as "at max", so devices only run once the battery is full. |
| `zendure_battery_max_charging_tolerance` | `50` | How many watts below the maximum still count as "at max". Measured power never exactly matches the limit. |

`zendure_battery_min_soc` has been removed and is now ignored. In `config.json`,
it is replaced by `zendure_battery_full_soc: 100`. The old value `> 99` meant
the same thing for whole-number SOC readings. Invalid values stop the
application at startup and report a configuration error.

## Code changes

- **`lib/battery-logic.js`** (new): `readSettings(config)` checks the settings.
  `getDeviceActivation({battery, powerAvailable, devicesPowerW}, settings)`
  returns the decision. This module has no I/O, so it can be tested on its own.
- **`main.js`**: `getDeviceChargingStatus()` now checks that the battery reading
  is fresh and passes it to `battery-logic`, together with the power used by
  running devices. The control loop checks the battery decision once per tick,
  before it handles any device. It no longer checks it again for each device.
  Battery updates still turn devices off immediately when activation is no
  longer allowed, including forced devices.
- **API**: `device_charging` in `/api/data` and `/api/battery` is now
  `{enabled, reason, socPercent, fullSocPercent, maxChargingPowerW}`.
  `minSocPercent` has been removed. Possible `reason` values:
  `battery-unavailable`, `power-unavailable`, `battery-discharging`,
  `battery-charging-at-max`, `battery-charging-below-max`, `battery-full`,
  `battery-not-full`.
- **Dashboard** (`views/index.ejs`, `lib/locales/{en,fr}.json`): the status line
  below the battery percentage explains each new reason in English and French.
  The old above/below-SOC messages have been removed.
- **README**: the configuration table and the device-charging section describe
  the new rule.
- **Nomenclature page** (`/nomenclature/`): new section "04 Activation logic"
  ("Logique d'activation" in French). It has an overview diagram (battery logic,
  then device A, device B, and so on) and two subsections. The battery logic
  subsection has a decision diagram, the rules, the LaTeX checks and four
  examples. The device logic subsection explains the surplus, has a decision
  diagram for one device, the on/off and adjustable rules, an example of two
  devices sharing the surplus, and the limits that keep a device off.
  Diagrams use Mermaid 11.4.1 from jsdelivr, next to the existing MathJax. If
  Mermaid cannot load, the diagram cards are hidden and the written rules remain.

## Tests

- `test/battery-logic.test.js` (new) covers each branch of the rule, the
  tolerance, the device-power correction, unknown maximum power, contradictory
  readings, invalid settings, and unavailable data.
- `test/main-battery-gate.test.js` runs the real server through discharging,
  charging below max, not full, charging at max (including the device-power
  correction) and full. It also covers forced mode, stale readings and invalid
  settings.
- `test/main.test.js` builds its expected status from the real `config.json`
  settings.

The full `npm test` suite passes: 197 tests.

## Action needed

Set `zendure_battery_max_charging_power` in `config.json` to the maximum
charging power of the SolarFlow. Until it is set, devices only start once the
battery reaches `zendure_battery_full_soc`.
