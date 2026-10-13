# Battery-aware consumption calculations

Updated on 13 October 2026.

Household consumption now uses:

`net grid power + solar production + battery discharge - battery charging`

Grid power keeps its existing sign: imports are positive and exports are negative.
Battery discharge comes from Zendure's `packInputPower`; charging comes from
`outputPackPower`. Both battery readings are positive magnitudes in watts.
For example, 500 W from the grid + 1,000 W solar + 300 W discharge - 200 W
charging gives 1,600 W of household consumption.

- `/graph/power/<period>` and `/device/list/graph/<period>` now show both battery
  flows and the corrected total. A shared `/api/data/consumption/<period>` query
  aligns readings by timestamp, supports the existing downsampling selector,
  and preserves device curves. Raw totals use only preceding fresh readings;
  averaged totals use matching windows and check battery field completeness.
- Both period and calendar-day energy APIs integrate the raw grid, solar, and
  battery series independently. Results include `battery_discharging` and
  `battery_charging` in kWh, and subtract charging from `house_consumption`.
  Existing local-day boundaries, 15-second final-sample tails, and rounding remain.
- Energy tables, request history, calendar, and the energy dashboard display
  battery totals. Dashboard totals and savings use `house_consumption`; its
  stacked breakdown shows charging and grid export as outflows.
- Missing battery fields remain unavailable rather than becoming zero. New
  daily calculations with incomplete battery fields return unavailable dependent
  totals; measured zero stays zero. English and French labels explain graph gaps.

Saved energy history is preserved. Legacy entries lack battery totals and retain
their recorded house totals until recalculated. For a day with both legacy and
battery-aware results, the dashboard uses the battery-aware results.

Validation covers charge/discharge signs, signed grid exchange, independent
timestamps, matching aggregation windows, missing/legacy readings, zero values,
the two energy APIs, and graph/table rendering. The full `npm test` suite passes.
