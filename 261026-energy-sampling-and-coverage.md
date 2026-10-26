# Energy sampling and coverage

Updated on 26 October 2026.

## Why

The daily energy integrates the stored power readings, so it is only as good as
what was stored. Before this change the grid and solar power were stored every
15 seconds, plus every second only while `power - activated devices < 0` (in
practice while exporting). On production data this meant:

- Degrading the 1 s windows of 24 October to 15 s moved the exported energy by
  about 26 % (-290 Wh on -1120 Wh) and the household total by about 1 %. The
  export figure was only reliable where the 1 s data happened to exist.
- The last 1 s reading before a gap always met the export condition, and was
  held until the next 15 s tick, which was usually an import period.
- A reading was held until the next one however long the gap: about 3 hours of
  grid time per week (gaps of 10 to 14 minutes almost every day) were filled
  with the last value, with no sign of it in the figures.

## What changed

- **Every poll is stored.** The control loop (`powerRequestThreshold`, 1 s with
  Zendure) writes each reading it gets, with no condition on the value. The
  separate 15 s writer (`influxLib.daemon`) is removed, since it would only
  duplicate those points. A failed poll still stores nothing.
- **A reading is held for at most 30 seconds** (`MAX_HOLD_MS` in
  [lib/compute-energy.js](lib/compute-energy.js)). The rest of a longer gap is
  missing: it adds no energy, to any of the series (grid, solar, battery
  charge and discharge, charging from the grid). The final reading of a day
  keeps its 15 s tail.
- **Coverage per series and day**: `coverage_network`, `coverage_solar` and
  `coverage_battery` (percent, one decimal, `null` when the series has no
  readings that day). The period is the whole local day, or up to now for
  today; `computeEnergy(network, solar, battery, {from, to})` takes it from
  [lib/energy-days.js](lib/energy-days.js). Without `from` and `to` it runs
  from the first grid reading to the end of the last one. The battery figure
  is the lower of its two directions.
- The energy day store gets three REAL columns (added to existing files on
  start), the day table shows the coverage above the figures (amber, with a
  reminder that missing periods are not counted, when a series is below
  100 %), and the nomenclature page explains it in English and French.

## Real data

On the three days of production readings from 23 to 26 October, the cap lowers
the daily totals by 1 to 2 % (24 October: grid import 42.605 to 42.191 kWh,
house 55.94 to 54.873 kWh) with a coverage of about 98 %. With the cap
disabled the code reproduces the stored totals exactly.

## To know

- Stored days keep their figures and have no coverage until "Recompute" (or the
  graph page, for partial days). A recomputed past day can come out lower, and
  only has 1 s readings from the day this version was deployed.
- Influx receives about 15 times more `power` points (one per second instead of
  one per 15 s outside export hours).
- `influx_update_delay` no longer sets how often power is stored. It remains
  only as the freshness window (twice its value) of the live power graph.
- Not changed: the inclusive midnight boundary. A reading stamped exactly
  00:00:00 also ends the previous day with a 15 s tail, so those 15 s are
  counted in both days. Grid and solar readings carry the arrival time in
  milliseconds and never hit it, but battery readings have a 1 s resolution and
  did so on each of the three days checked (at 0 W each time; at most about
  10 Wh when charging at 2.5 kW).
- Device energy (`energy_method`) is a separate calculation and is untouched.
