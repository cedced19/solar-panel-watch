# Energy summary


## Current status: energy request architecture (24 October 2026)

Four pages share one calculation and one store. Only two routes compute energy;
the other pages read or aggregate what those routes saved.

```
/energy/<duration>  ─► GET /api/data/energy/<duration> ──┐
                                                         ├─► computeEnergy() ─► energy-query-save.json
/energy-calendar/   ─► GET /api/data/energy/day/<date> ──┘          (db_energy, one entry per request)
        │                                                                 │
        └─ GET /api/data/energy-calendar/ ◄── distinct days ──────────────┤
                                                                          │
/energy-hist/   ─► GET /api/data/energy-request-hist/ ◄───────────────────┤
/energy-graph/  ─► GET /api/data/energy-request-hist/ ◄───────────────────┘
```

### 1. Calculation path (`/energy/<duration>` and the calendar day)

- [views/energy.ejs](views/energy.ejs) fetches `/api/data/energy/<period>` on load.
  The period is validated by `validatePeriod` and comes from the URL
  (the home page links to `/energy/3d`).
- `/api/data/energy/<period>` calls `requestConsumptionOverPeriod(period)`;
  `/api/data/energy/day/<date>` calls `requestConsumptionOverRange(start, stop)`
  for one local day. Both are in [lib/consumption-history.js](lib/consumption-history.js)
  and run one Flux query without `every`, so the data is raw (no downsampling).
  It returns three series: `power1` (grid), `power2` (solar) and `battery`
  (`socPercent`, `packInputPower`, `outputPackPower` merged by timestamp).
- [lib/compute-energy.js](lib/compute-energy.js) `computeEnergy(power1, power2, battery)`
  integrates each series on its own, per local day, and returns one object per day:
  `start_date`, `end_date`, `consumption_on_network`, `introduced_on_network`,
  `solar_panel`, `battery_discharging`, `battery_charging`, `house_consumption`
  (kWh, floored to 3 decimals). A day with no grid data is omitted. Missing solar
  or battery values are `null`, and the battery adjustment is applied only when
  both directions exist.
- Both routes answer with that array and then append
  `{date, period, result}` to the store. The write happens after the response
  and is not awaited, so a write failure is only logged. `period` is either the
  duration (`3d`) or the date (`2026-10-13`).

### 2. Store

- `db_energy` is a `json-store-list` file, `./energy-query-save.json`
  (git-ignored). It is append-only: every call to either route adds an entry,
  with no deduplication and no size cap (the activation store, by contrast,
  is capped at 200). Repeating `/energy/3d` therefore stores overlapping
  results that the graph page has to reconcile.
- Nothing is rewritten after the fact. Legacy entries keep their saved totals.

### 3. Readers

- **`/energy-hist/`** ([views/energy-request-hist.ejs](views/energy-request-hist.ejs)):
  `GET /api/data/energy-request-hist/` returns the full store. The page lists
  requests newest first, with one table per request. It does not compute
  anything.
- **`/energy-graph/`** ([views/energy-graph.ejs](views/energy-graph.ejs)):
  loads the same endpoint and flattens every `result` into one list of days.
  `preferBatteryAwareCalculations` then keeps, for each day, only the entries
  of the best tier: complete battery data, then the new schema with battery
  fields, then legacy. Repeated calculations inside the best tier are kept.
  The date-range controls, the aggregation selector and the optional weather
  overlay (fetched from the Open-Meteo archive in the browser) work on that list.
  Graphs: consumption, solar, battery discharging, battery charging, saved,
  introduced, total used and the stacked breakdown, plus the per-month or
  per-year table.
- **`/energy-calendar/`** ([views/energy-calendar.ejs](views/energy-calendar.ejs)):
  `GET /api/data/energy-calendar/` returns the distinct local days that appear
  in any saved `start_date`, which colours the days. Clicking a day calls
  `/api/data/energy/day/<date>`, which recomputes it and stores the result.
  The calendar therefore both reads the store and feeds it.
- [assets/energy-consumption.js](assets/energy-consumption.js) is shared by the
  four pages: `normalizeEntry` recovers a grid + solar total for legacy entries
  whose total was unavailable, and `savedEnergy` is that total minus grid
  imports.

### 4. Observations

- The graph and history pages only show days that someone has already
  requested through `/energy/<duration>` or the calendar. There is no
  background job and no on-demand fill-in, so a new battery-aware figure for an
  old day appears only after that day is clicked in the calendar.
- Calendar coverage means "a result was saved once", not "the day is complete".
  A day saved while still in progress, or before battery data existed, shows as
  covered. The graph prefers the battery-aware entry once one exists.
- `/energy/<duration>` does not align with local days at its start, so its
  first and last days are partial. On the graph page, a day with several saved
  entries (repeated requests, or a partial entry plus a calendar entry) is
  reduced with `max` in the day view, which hides the duplicates. The week,
  month and year views sum every entry instead, so repeated or overlapping
  requests are double-counted there. This is the main correctness risk of the
  current design.
- Growth and slowness of the JSON file are unbounded. Every page load of
  `/energy/<duration>` adds an entry, and `/energy-graph/` and `/energy-hist/`
  download all of them.
- Tests: [test/main-energy.test.js](test/main-energy.test.js) covers the three
  API routes and the calendar page; [test/energy-views.test.js](test/energy-views.test.js)
  covers the table pages and the graph page; [test/compute-energy.test.js](test/compute-energy.test.js)
  covers the calculation.

## Target

## Change to do