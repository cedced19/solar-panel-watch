# Solar Panel Watch: project summary and rewrite options

Reviewed on 12 October 2026. This report is based on the repository's source, configuration, deployment files and existing tests. No live hardware or database validation was performed, and the test suite was not run for this documentation change.

## What the project does

Solar Panel Watch is a home electricity dashboard and surplus-power controller. It reads grid import/export from a Zendure meter, solar production from Shelly, and battery state from a Zendure SolarFlow device. It allocates available surplus to configured loads in priority order, subject to battery charge, energy limits, temperature/control-variable limits and device connectivity.

Devices poll the server for instructions: normal mode returns `{toggle, time_limit}`, while advanced mode returns `{alpha, time_limit}` for variable power using a calibration table. The server does not directly switch appliances; their clients must apply these responses. Manual forced operation remains subject to the battery and house-power gates.

The web interface provides live readings, power and battery graphs, energy summaries, a calendar, activation history, CSV downloads and English/French translations. The energy graph also retrieves historical weather from Open-Meteo in the browser.

## Current implementation

| Area | Implementation |
| --- | --- |
| Application | Node.js/CommonJS, Express and EJS; `main.js` contains about 1,170 lines of routes, mutable device state and background tasks. |
| Hardware adapters | `lib/zendure.js`, `lib/get-informations.js` and `lib/get-power-data.js`; LAN HTTP requests, caching, shared requests and MAC-based address recovery. |
| History | InfluxDB v2 with Flux queries; `power`, `var` and `battery` measurements. JSON files store energy-query history, activation history and forced settings. |
| Calculations | `lib/compute-energy*.js` and `lib/get-alpha.js`; daily kWh, device Wh and calibrated power allocation. |
| Frontend | EJS pages, CSS and browser JavaScript with Plotly. Some substantial browser logic lives inside templates. |
| Deployment/testing | Docker Compose and a systemd example; 11 test files covering adapters, recovery, battery gates, APIs, history and browser graph behavior. `bot/` contains simulated polling clients. |

The checked-in configuration selects Zendure house power, polls power every 1 second and battery status every 20 seconds, and stores every power reading it polls in the power history (no separate 15-second writer, no condition on the value). The battery minimum is **99%**, and permission requires SOC **strictly above** that value; the code default when omitted is 80%. The configured timezone is `Europe/Paris`.

## Language comparison

All three options below are feasible. The effort ratings are engineering judgments assuming similar familiarity with each language. No profiling establishes a need for greater computational speed: the main work is HTTP I/O, database queries and modest control calculations.

| Option | Main benefit | Main cost | Assessment |
| --- | --- | --- | --- |
| **Go** | Compiled service, straightforward deployment and concurrency; much of the HTTP/JSON/template stack can use the standard library. | Backend port and EJS template conversion; concurrent state needs deliberate ownership. | Recommended for a full rewrite. |
| **Rust** | Explicit types and ownership support careful modeling of readings, failures and shared state. | More implementation complexity around asynchronous tasks, ownership and database integration. | Good if Rust expertise or resource constraints justify the work. |
| **TypeScript on Node.js** | Existing Express, EJS, browser assets and InfluxDB integration can be retained while introducing types and modules. | Keeps the Node runtime and dependency deployment. | Best choice for an incremental modernization with less migration risk. |

### Implementing it in Go

Use [`net/http`](https://pkg.go.dev/net/http) for both the server and hardware clients, `encoding/json` for typed configuration/readings, and [`html/template`](https://pkg.go.dev/html/template) to replace EJS. Static assets can be packaged with [`embed`](https://pkg.go.dev/embed). Retain the existing CSS, Plotly, browser scripts and locale dictionaries; browser JavaScript still has a role after a backend rewrite.

Use InfluxData's [`influxdb-client-go/v2`](https://github.com/influxdata/influxdb-client-go), which supports InfluxDB 2.x and Flux. Keeping the database, measurements, field names and tags avoids migrating existing history. Start with compatible JSON persistence and atomic file replacement; SQLite could later replace local state/history files as a separate change.

Separate configuration, hardware adapters, controller, storage and HTTP/UI packages. Give one goroutine ownership of device state and feed it meter updates and device requests through channels. Publish snapshots for dashboard reads, keep network I/O outside state transitions, and use deadlines, cancellation and bounded workers for polling and discovery. Run `go test -race` when validating the port.

### Implementing it in Rust

Use [`Axum` with Tokio](https://docs.rs/axum/latest/axum/) for routes and asynchronous tasks, and [`Reqwest`](https://docs.rs/reqwest/latest/reqwest/) for LAN HTTP requests. Model payloads/configuration with Serde, and represent unavailable readings explicitly with `Option`/`Result`. Retain the browser assets and convert EJS into Rust templates or HTML pages that fetch the APIs.

Use the same state-owner/channel design as Go. For InfluxDB, evaluate a community client for the required v2/Flux features or implement a small HTTP adapter for writes and queries, including annotated CSV parsing. Rust is absent from InfluxData's [v2 client-library list](https://docs.influxdata.com/influxdb/v2/api-guide/client-libraries/), so verify integration support before committing to a crate. Benchmark the deployed service before claiming memory or latency gains.

## Behavior to preserve or resolve explicitly

- **Availability:** house-meter failure closes the device gate, with no automatic fallback to Shelly. Missing solar remains `null` and a gap in history; measured zero remains zero. Battery failure leaves house readings available but closes the device gate.
- **Battery freshness:** cached responses must retain their original reading time. Current expiry is the battery interval plus the request timeout. Preserve the strict SOC comparison and its precedence over forced mode.
- **Device protocol:** preserve names/IDs, response fields, polling intervals, priority allocation, hysteresis and the alpha calibration table (`128` means off). A server outage requires device clients to implement their own timeout-to-off behavior.
- **Energy semantics:** daily totals currently assume aligned house/solar arrays and use server-local dates, a fixed 15-second final tail and special midnight handling. A reading is held for at most 30 seconds; longer gaps are missing and reported as per-day coverage. Solar gaps can invalidate the aligned-arrays assumption. Device energy uses either Flux's trapezoidal integral or a staircase calculation with a tail to the present; these are not equivalent. Add reference cases and decide which differences are compatibility requirements versus corrections, including timezone/DST and missing samples.
- **Persistence and API hygiene:** import existing JSON state before switching ownership. Move credentials from tracked configuration/deployment files to runtime secrets; replace password-bearing forced-control GET URLs with authenticated mutation requests through a deliberate compatibility transition.

## Practical migration

1. Capture API response fixtures and controller examples, especially outages, SOC at/above 99%, forced mode, priorities and alpha boundaries. Reuse scenarios from the existing tests and add energy reference cases.
2. Implement adapters and a pure controller in the chosen language. Replay recorded inputs and compare decisions with the current service before connecting device clients.
3. Preserve InfluxDB v2/Flux and existing endpoint contracts; convert templates while reusing browser assets. Run the replacement on a separate port with fixture or read-only inputs and isolated history writes.
4. Import local state and switch device clients to one controller after validating parity. Keep a rollback path and verify appliance timeout behavior during the switch.

**Recommendation:** choose Go if the objective is a maintainable compiled service with simpler deployment. Choose TypeScript if the priority is improving the existing project quickly. Rust is technically suitable, but its additional work should serve a concrete requirement. The most valuable change in any option is separating control decisions from HTTP, polling and persistence.

Repository references: [application](main.js), [power acquisition](lib/get-power-data.js), [Zendure adapter](lib/zendure.js), [InfluxDB integration](lib/influx-lib.js), [daily energy](lib/compute-energy.js), [device energy](lib/compute-energy-device.js), [tests](test/) and [deployment](docker-compose.yml).
