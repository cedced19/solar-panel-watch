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
- The live home page uses the same balance for its total-power card and shows
  both battery directions. Its refreshes recalculate the total whenever either
  power or battery data arrives, while incomplete battery readings fall back to
  net grid power plus solar production.
- Both period and calendar-day energy APIs integrate the raw grid, solar, and
  battery series independently. Results include `battery_discharging` and
  `battery_charging` in kWh, and subtract charging from `house_consumption`.
  Existing local-day boundaries, 15-second final-sample tails, and rounding remain.
- Energy tables, request history, calendar, and the energy dashboard display
  battery totals. Dashboard totals and savings use `house_consumption`; its
  stacked breakdown shows charging and grid export as outflows.
- When battery history is missing or incomplete, household power and total energy
  used include only net grid exchange plus solar production. Energy saved uses
  that total minus grid imports, with no battery contribution. Battery
  adjustments apply only when both charge and discharge data are available;
  neither flow is applied on its own. Missing battery values remain unavailable
  in their own curves and columns, while measured zero stays zero. Grid and solar
  readings are still required for household totals.

Saved energy history is preserved. Legacy entries retain their recorded house
totals. Reports with an unavailable total caused by missing battery data now
display a total and savings from their saved grid and solar values, without
rewriting the database. For a day with both legacy and battery-aware results,
the dashboard uses the battery-aware results. Complete battery calculations
take precedence over fallback estimates for the same day.

The English and French Nomenclature page explains this fallback and distinguishes
missing battery measurements from a measured zero.

Validation covers charge/discharge signs, signed grid exchange, independent
timestamps, matching aggregation windows, missing/legacy readings, zero values,
the two energy APIs, and graph/table rendering. The full `npm test` suite passes.
