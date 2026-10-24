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

One summary per local day, computed once and read by range. Nothing is stored
per request any more, so nothing has to be reconciled afterwards.

```
/energy-graph/#duration=N ─► GET /api/data/energy/days?start=&end= ──┐
        │  (then, for each stale day)                                 │
        └────────────────► GET /api/data/energy/day/<date> ──┐        │
/energy-calendar/ ───────► GET /api/data/energy/day/<date> ──┤        │
/energy/current-day ─────► GET /api/data/energy/day/<today> ─┤        │
"Recompute" button ──────► POST /api/data/energy/day/<date>/recompute │
                                                             ▼        ▼
                 influx (one local day) ─► computeEnergy() ─► energy-days.sqlite
                                                              (table energy_day,
/energy-calendar/ ───────► GET /api/data/energy-calendar/ ◄──  one row per day)
```

- **Store.** `energy-days.sqlite` (built-in `node:sqlite`, no npm dependency,
  a few MB of RAM), git-ignored. Table `energy_day`, primary key `day`
  (local `YYYY-MM-DD` in the server timezone), the `computeEnergy` fields,
  `complete` (1 when computed after the day ended), `computed_at` and
  `source` (`influx` or `legacy`). A day without grid data is stored with null
  values, so it is not queried again.
- **Calculation.** Always one local day: `requestConsumptionOverRange(start,
  stop)` then `computeEnergy()` (unchanged). A complete stored day is served
  as is; a missing or partial day is computed and stored. Today is stored as
  partial and overwritten on each request; once the day is over it is
  recomputed and becomes complete. An empty result never replaces a row that
  has data (raw Influx data may be gone for old days). Concurrent requests
  for the same day share one Influx query.
- **Pages.**
  - `/energy-graph/#duration=N` shows the last N days (today included); no
    hash shows the whole stored period. The page loads the stored rows of
    the range, then computes each stale day one after another, with a
    progress indicator. One row per day, so week, month and year views are
    plain sums with no double counting. Clicking a day bar shows that day's
    table with a "Recompute" button.
  - `/energy-calendar/` keeps its calendar, coloured from the store
    (data, partial, no data). Clicking a day shows the stored figures, or
    computes them; a "Recompute" button forces a new calculation.
  - `/energy/current-day` shows today's figures.
  - `/energy/<N>d` redirects to `/energy-graph/#duration=N` for old links.
- **Removed.** `/energy-hist/`, `/api/data/energy-request-hist/`,
  `/api/data/energy/<duration>`, `energy-query-save.json` and the
  `preferBatteryAwareCalculations` reconciliation on the graph page.
- **Legacy data.** [lab/convert-legacy/convert.js](lab/convert-legacy/convert.js)
  converts `energy-query-save.json` into the store once.
- **Runtime.** `node:sqlite` needs Node 22.13 or later, so the Docker images
  move from `node:16` to `node:24`.

## Change to do

1. **Store** — new [lib/energy-day-store.js](lib/energy-day-store.js):
   `createEnergyDayStore(filename)` with `get(day)`, `range(start, end)`,
   `days()` (`{day, complete, has_data}`), `put(day, summary, {complete,
   source})` (upsert), `insertIfAbsent(...)` and `close()`.
2. **Service** — new [lib/energy-days.js](lib/energy-days.js):
   `createEnergyDays({store, influx, computeEnergy, now})` with
   `localDayKey`, `dayBounds`, `getDay(day, {force})`, `staleDays(start, end)`
   and the in-flight deduplication. `localDayKey`/`padTwo` and the day
   bounds move there from `main.js`. A day is complete when computed at least
   5 minutes after its end.
3. **Routes** ([main.js](main.js)):
   - `GET /api/data/energy/days?start=&end=` → `{days, stale}`;
   - `GET /api/data/energy/day/:date` → one row (stored or computed);
   - `POST /api/data/energy/day/:date/recompute` → forced calculation;
   - `GET /api/data/energy-calendar/` → `store.days()`;
   - `GET /energy/current-day`, and `GET /energy/:period` as a redirect;
   - remove `db_energy`, `/api/data/energy/:period`,
     `/api/data/energy-request-hist/`, `/energy-hist/` and
     [views/energy-request-hist.ejs](views/energy-request-hist.ejs).
     `json-store-list` stays for the activation history.
4. **Views**:
   - new partial `views/partials/energy-day-table.ejs`: the day table now
     duplicated in the calendar and energy pages, with the "Partial day" note
     and the "Recompute" button;
   - [views/energy.ejs](views/energy.ejs): current day only;
   - [views/energy-calendar.ejs](views/energy-calendar.ejs): new calendar
     format, stored-or-computed click, recompute;
   - [views/energy-graph.ejs](views/energy-graph.ejs): `#duration` and
     `hashchange`, range loading with stale-day filling, sum aggregation,
     click on a day bar with recompute; date inputs limited to today;
   - [views/index.ejs](views/index.ejs) and
     [views/nomenclature.ejs](views/nomenclature.ejs): links to
     `/energy-graph/#duration=3` and `/energy/current-day`, no
     `/energy-hist/`;
   - [lib/locales/en.json](lib/locales/en.json) and
     [lib/locales/fr.json](lib/locales/fr.json): new labels.
5. **Legacy converter** — `lab/convert-legacy/convert.js [input] [output]`,
   run with the server timezone (`TZ=Europe/Paris`, or through
   `docker compose run --rm node`). A row is complete when its span starts
   within 5 minutes of local midnight and ends within 5 minutes of the next
   one. For each local day of `start_date`, keep a complete row first, then
   the best battery tier (complete battery data, then battery fields, then
   legacy), then the widest `start_date`–`end_date` span, then the latest
   request. `computed_at` is the request date. Rows already in the store
   are never overwritten. A partial legacy day requested before the day
   ended is refreshed by the graph page; the others (computed after the
   day ended, so most likely real data gaps) only with "Recompute".
6. **Runtime** — `node:24` in every `docker-compose*.yml`, `engines` in
   [package.json](package.json), `energy-days.sqlite*` in `.gitignore`,
   README section on the energy pages and the migration.
7. **Tests** — new `test/energy-day-store.test.js`,
   `test/energy-days.test.js` and `test/convert-legacy.test.js`; rewrite
   [test/main-energy.test.js](test/main-energy.test.js) for the new routes;
   adapt [test/energy-views.test.js](test/energy-views.test.js) and the route
   list of [test/nomenclature.test.js](test/nomenclature.test.js).

### Migration

1. Deploy on `node:24` and reinstall `node_modules`.
2. Run the converter once on the old `energy-query-save.json`.
3. Start the server; open `/energy-graph/` to fill the gaps.
4. Remove `energy-query-save.json` once the result looks right.