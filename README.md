# solar-panel-watch
Watch over electricity consumption from my house.

![Demo](demo.png)

## config.json

`config.json` holds this installation's settings and secrets and is not tracked
by git. `config-default.json` is the tracked template: on start (and before
`npm test`), a missing `config.json` is created from it, and keys added to the
template later are copied into an existing `config.json`. Values already set in
`config.json` are never changed, and an empty `auth.jwt_secret` is replaced by a
random one.

> **Upgrading a checkout where `config.json` was still tracked:** pulling the
> commit that untracks it deletes the local file. Keep a copy first:
> `cp config.json config.local.json && git pull && mv config.local.json config.json`.

It can also be edited online, see [Configuration panel](#configuration-panel).

```json
{
    "ip_adress_shelly": "192.168.0.91",
    "influx_tocken": "tocken",
    "influx_org": "cedced19@gmail.com",
    "influx_bucket": "solar-panel",
    "influx_default_tag": "home1",
    "influx_update_delay": 15000,
    "influx_url": "https://**********.influxdata.com",
    "timezone": "Europe/Paris",
    "shelly_req_threshold": 3000,
    "house_power_source": "zendure",
    "zendure_req_threshold": 1000,
    "zendure_request_timeout": 3000,
    "zendure_meter": {
        "host": "192.168.0.48",
        "serial": "TEE1NJP7P341978",
        "mac_address": "E0:72:A1:85:24:4B",
        "wlan_mac_address": "E0:72:A1:85:24:48",
        "recover_by_mac": true,
        "power_field": "total_power",
        "power_scale": 1
    },
    "zendure_battery_req_threshold": 20000,
    "zendure_battery": {
        "host": "192.168.0.40",
        "serial": "ANACVCDLP283458",
        "battery_serial": "BEAAVCDLA283460",
        "mac_address": "90:64:9B:10:9A:14",
        "recover_by_mac": true
    },
    "energy_req_threshold": 1200000,
    "target_req_threshold": 240000,
    "auth": {
        "mails": ["cedced19@gmail.com"],
        "sender": {"user": "", "pass": ""},
        "smtp": {"host": "smtp.gmail.com", "port": 587},
        "jwt_secret": "",
        "otp_ttl_minutes": 5,
        "token_validity_hours": 8760
    }
}
```

## Configuration panel

`/config/` (linked from the dashboard) edits `config.json` and
[`devices-to-activate.json`](#devices-to-activatejson) in the browser, as a
form or as raw JSON; the tabs above the form switch between the two files. It
and the force page (`/force/`) are the only pages that need a login; every
other page and API stays open. Both pages share the same
login and token, so signing in on one signs in on the other. The login works
like domotic-center:

1. Enter an address listed in `auth.mails`. A 6-digit code, valid
   `otp_ttl_minutes`, is emailed through the `auth.sender` Gmail account.
2. Enter the code. The browser keeps the returned token (valid
   `token_validity_hours`) in `localStorage`.

While `auth.sender` is empty, the login form also asks for the sender: a Gmail
address and one of its [app passwords](https://myaccount.google.com/apppasswords).
The code is sent through it and it is saved to `config.json` only once that code
is verified, so the sender is known to work and never has to be committed.

Saving keeps the previous file in `config.json.bak` (`devices-to-activate.json.bak`
for the devices). Changes to `auth` (allowed emails, sender) apply immediately,
and removing an address ends its sessions. Other settings and the devices are
read at startup, so the panel then offers a restart: the process exits and
docker/systemd (`restart: always`) starts it again. Under nodemon (`docker-compose-reload.yml`) the app stays stopped until
the next file change.

## Forcing devices

`/force/` (linked from the dashboard) forces a connected device to a level, or
gives it back to the automatic logic, once signed in. Its API takes the same
`Authorization: Bearer <token>` header and answers HTTP 401 without it:

- `GET /api/data-force`: forcing state and power of each connected device.
- `PUT /api/device/:name/force` with `{"percent": 0.5}`: forces the device to
  that share of its power, between 0 and 1 (0 keeps it off). Any other value
  returns HTTP 400.
- `DELETE /api/device/:name/force`: stops forcing the device.

A device that has not called the app since it started returns HTTP 404.

## devices-to-activate.json

`devices-to-activate.json` lists the devices the app controls and is not tracked
by git, like `config.json`. `devices-to-activate-default.json` is the tracked
template: on start (and before `npm test`), a missing `devices-to-activate.json`
is created from it. Unlike `config.json`, an existing file is never completed
from the template, because the optional keys (`min_alpha`, `max_energy_val`,
`max_control_var_val`, ...) switch a feature on for a device.

It is edited on the `/config/` page ([Configuration panel](#configuration-panel)),
which refuses a file the app could not start with: a device needs a `uri` of
letters, digits, `-` and `_` (unique), a positive `power_limit` and `time_limit`,
a `power_threshold_percentage` between 0 and 1, a number `priority` and a list
of `ids`. Devices can be added or removed in the JSON tab. Server-side
procedure and the meaning of the margin: [EDIT_CONFIG.md](EDIT_CONFIG.md).

> **Upgrading a checkout where `devices-to-activate.json` was still tracked:**
> pulling the commit that untracks it stops with "Your local changes would be
> overwritten" if the file was edited, and deletes it otherwise (the app then
> recreates it from the template, losing your values). Keep a copy first:
> `cp -p devices-to-activate.json devices-to-activate.local.json && git checkout devices-to-activate.json && git pull && mv devices-to-activate.local.json devices-to-activate.json`.

```json
[
    {
        "uri": "water-heater",
        "power_limit": 400,
        "time_limit": 30000,
        "power_threshold_percentage": 0.05,
        "ids": ["Q7qR9"],
        "priority": 1
    },
    {
        "uri": "heat-pump",
        "power_limit": 1000,
        "time_limit": 35000,
        "power_threshold_percentage": 0.10,
        "ids": ["8yaPTC"],
        "priority": 2
    }
]
```

## docker

```
sudo docker compose up
```

```
sudo docker compose -f docker-compose-npm-install.yml up
sudo docker exec -it solar-panel-watch-node-1 bash # to run in parallel
```

### Development with hot-reload

For development with automatic reloading when `.js` or `.ejs` files change:

```
sudo docker compose -f docker-compose-reload.yml up
```

This uses `nodemon` to watch for file changes and automatically restart the Node.js application. The configuration watches:
- `*.js` files in the root directory
- `lib/**/*.js` files
- `views/**/*.ejs` files
- `bot/**/*.js` files

to remove volume:
```
sudo docker volume rm solar-panel-watch_data
```

## Application power sources and battery

House power now comes from the Zendure Smart Meter 1CT-S. Shelly is polled at
the same time for solar production only. An offline Shelly leaves solar production
and total power unavailable; Zendure house power and device decisions keep working.
If Zendure house power fails, automatic device activation stops until a valid
reading returns. House power never silently falls back to Shelly.

Configure these settings in `config.json` and restart the application:

| Setting | Purpose |
| --- | --- |
| `house_power_source` | `zendure` (configured default) or `shelly` for an explicit rollback. |
| `zendure_req_threshold` | House polling/cache interval in milliseconds; default `1000`, matching the existing Shelly cadence. |
| `zendure_request_timeout` | Deadline for each Zendure HTTP request; default `3000` ms. |
| `zendure_meter` | Meter `host`, expected `serial`, `mac_address` (LAN interface), `wlan_mac_address` (WLAN interface, optional) and `recover_by_mac`. |
| `zendure_meter.power_field` | Field to read from `/properties/report`; default `total_power`. |
| `zendure_meter.power_scale` | Multiply the raw field to obtain signed watts; default `1`. Positive means grid import, negative means export. Set a negative scale if the CT orientation reverses the sign. |
| `zendure_battery_req_threshold` | Independent battery polling/cache interval; configured as `20000` ms. |
| `zendure_battery_full_soc` | Fallback for the charge percentage from which an idle battery counts as full and devices may run; default `100` (a number from `0` to `100`). Used only when Zendure does not report its charge target (`socSet`). |
| `zendure_battery_max_charging_power` | Fallback for the maximum battery charging power in watts. While the battery charges at this power, devices may use the extra surplus. Used only when Zendure does not report its maximum charge power (`chargeMaxLimit`). Unset by default, so without either value devices only run once the battery is full. |
| `zendure_battery_max_charging_tolerance` | How many watts below the maximum still count as "at max"; default `50`. |
| `zendure_battery_ignore_state` | When `true`, the `state` reported by Zendure is ignored and only the measured charging/discharging power decides whether the battery counts as charging or discharging; default `false`. |
| `zendure_battery` | SolarFlow `host`, device `serial`, expected `battery_serial`, `mac_address`, optional `wlan_mac_address`, and `recover_by_mac`. |

The supplied device addresses and identities match the standalone probes below.
Enable the local API/HEMS setting in the Zendure app. The library reads LAN status
without cloud credentials or control commands. A returned serial must match when
present; a serial-less meter response remains unverified. MAC recovery uses an
exact match within the configured host's `/24` subnet and keeps the recovered
address in memory.

### MAC recovery: LAN, then WLAN

The Zendure devices have one MAC address per network interface. The 1CT-S meter
uses `E0:72:A1:85:24:4B` on its LAN (cable) interface and `E0:72:A1:85:24:48` on
its WLAN (Wi-Fi) interface, and gets a different IP address on each. With
`recover_by_mac` enabled, when the configured `host` stops answering (or answers
with another serial) the server looks the device up by MAC address, in this order:

1. `mac_address`: the **LAN** interface.
2. `wlan_mac_address`: the **WLAN** interface, so the meter is found again at its
   Wi-Fi address when the cable is unplugged or the LAN port is down.

A single scan of the `/24` subnet serves both lookups (it fills the system's
ARP/neighbor table), so having a second MAC does not double the scan time. The
LAN MAC wins when both interfaces answer; the WLAN address is used only once the
scan found no LAN address, so when only the WLAN one is on the network the scan
covers the whole subnet (a few seconds, once) before settling on it. The device found must still return a matching report
(serial, readiness) before the address is kept; it is never written to
`config.json` and a restart goes back to the configured `host`. `wlan_mac_address`
is optional (leave it out or empty to search the LAN MAC only) and the same two
keys are read for `zendure_battery`. If both keys hold the same address it is
searched once.

The dashboard (`/`) shows which interface the temporary address belongs to, for
example `Zendure was temporarily recovered at IP address 192.168.0.37 (WLAN)`, and
lists both MAC addresses when none of them is found on the network.

> Upgrading: `mac_address` used to hold the meter's `...:48` address, which is the
> WLAN one. `config.json` keeps your value and gets `wlan_mac_address` added from
> the template; set `mac_address` to the LAN address (`...:4B`) so the order above
> applies.

The battery card shows the matching pack's charge percentage, state and charging
power in watts (`chargingPowerW`, from Zendure's `outputPackPower`). A missing
charging power reading is shown as unavailable; a reported zero remains `0 W`. If pack
charge is unavailable, it uses `electricLevel` and labels it as the device average.
Battery failures show an unavailable state without blocking house power readings. The
server polls the battery on its own `zendure_battery_req_threshold` interval, while
the dashboard (`/`) only refreshes its display: one hard-coded 10 s timer in
[`views/index.ejs`](views/index.ejs) fetches `/api/data` and `/api/battery` together,
so power and battery cards update at the same pace. Reloading faster would add
nothing for a human reader; concurrent requests share the same cached reading or
in-flight request.

The battery is charged first. Devices in normal and advanced modes are
activated only when the battery cannot take more power
(see [`lib/battery-logic.js`](lib/battery-logic.js)):

| Battery | Devices |
| --- | --- |
| Discharging | Off |
| Charging at the maximum charging power | Allowed |
| Charging below that power | Off |
| Idle and at or above the full level | Allowed |
| Anything else | Off |

The maximum charging power is `chargeMaxLimit` and the full level is `socSet`
(the charge target), both read from the same Zendure report. The configured
`zendure_battery_max_charging_power` and `zendure_battery_full_soc` only apply
when Zendure does not report a valid value. `device_charging` shows the values in use.

Forcing is decided before the battery: a forced device runs at its forced
level whatever the battery reports. It still stops when house power is
unavailable, when the device is disconnected, or when its energy or temperature
limit is reached.

For devices that are not forced, this battery check is evaluated before their
surplus logic and only uses the battery's own readings: "at maximum" compares the charging power
reported by Zendure with the maximum charging power, and running
devices are not taken into account. Devices also stay off while battery status is unavailable or stale,
or while house power is unavailable. When allowed, the existing surplus,
priority, energy and temperature limits still apply. A small status below the
battery percentage explains whether devices may run and why. Readings expire
after the battery polling interval plus the Zendure request timeout.

`GET /api/data` retains `power1` (house) and `power2` (solar) and includes
`house_power_source`. Unavailable solar power is `null`, never a fabricated zero.
Calendar-day energy queries integrate network and solar readings on
their own timelines, holding each reading until the next reading within that day.
Gaps or differing timestamps do not discard the day's solar production or combined
house consumption. Those totals are `null` only for days with no usable solar
readings, and are displayed as unavailable in the energy views.

### Energy summaries

Energy is stored once per local day in `energy-days.sqlite` (built-in
`node:sqlite`, Node 22.13 or later). A day is computed from its raw readings
the first time it is requested, and again while it is partial (today, or a day
computed before it ended).

- Every day at 00:30 (server time), the day that just ended is computed and
  stored, so the pages find it ready. A day already stored complete is kept.
  It also runs at startup, for a night the server missed, and a failed
  calculation (InfluxDB unreachable) is tried again at the next 5-minute mark.
  The schedule uses [croner](https://croner.56k.guru/), in `main.js`.
- `/energy-graph/#duration=N`: the last N days, computing missing days on load.
  Clicking a bar in the day view shows that day with a "Recompute" button.
- `/energy-calendar/`: stored days by month; a click shows or computes a day,
  with the same charts as the current day (except the power since midnight and
  the hourly energy). `/energy-calendar/#day=YYYY-MM-DD` opens a given day.
  Two arrows, or a swipe on a touch screen, move to the previous or next day,
  up to today.
- `/energy/current-day`: today's figures and charts. Its previous-day arrow or a
  swipe right opens `/energy-calendar/#day=<yesterday>`.
- Each day also has `charging_energy_from_network`: the battery charging
  between 22:00 and 06:00 local time, which cannot come from the solar panels.
  The energy flow diagram draws it as grid → battery. Days stored before this
  field have it empty (the diagram then counts charging as solar first) until
  they are recomputed with "Recompute".
- `battery_max_soc` is the highest battery level (percent, one decimal) read
  during the local day, from the `socPercent` of the battery readings; it is
  empty when the day has no valid level. The day at a glance, on the calendar and
  the current-day pages, shows it as a third gauge, "Battery peak level". Days
  stored before this field have it empty until they are recomputed with
  "Recompute" (the gauge then reads "Unavailable").
- `devices_consumption` is the energy of all the devices of
  `devices-to-activate.json` together, from their power in InfluxDB. A device
  writes its power when it changes, so each value holds until the next one
  (the power at midnight is the last value of the week before). It is part of
  the household use: the energy flow diagram splits the household use into
  the devices and the rest, and the solar energy chart gives the devices the
  household's solar first (an estimate from the day totals). A button on the
  energy flow hides the devices from both charts (the choice is kept in the
  browser); the table always shows the figure.
- Power readings are stored at every poll (every second with the default
  `zendure_req_threshold`), whatever their value. The energy of a day integrates
  them: a reading is held until the next one, for at most 30 seconds. A longer
  gap is missing, so its energy is not counted, and each day reports its
  coverage as `coverage_network`, `coverage_solar` and `coverage_battery`: the
  percentage of the day (up to now for today) that the grid, solar and battery
  readings cover. Totals are a minimum when coverage is below 100 %. The day
  table shows it above the figures. Days stored before this field have it empty
  until they are recomputed with "Recompute"; that recomputation also applies
  the 30 s limit, so its totals can come out lower than before.
  The readings are sent to InfluxDB in batches every 5 seconds, each stamped when it
  was polled; the buffer is also sent when the server stops (SIGTERM, Ctrl-C or a
  restart from the configuration panel), but a crash can lose the last few
  seconds. A day's energy is integrated while the readings stream from InfluxDB,
  so computing it needs little memory whatever the sampling rate.
  `influx_update_delay` no longer sets how often power is stored; it only sets
  how old a stored reading may be to count as fresh in the power graph (twice
  its value).
- `GET /api/data/energy/days?start=YYYY-MM-DD&end=YYYY-MM-DD` returns
  `{days, stale}`; `GET /api/data/energy/day/<date>` returns one day;
  `POST /api/data/energy/day/<date>/recompute` forces a calculation.

To import the former request history (`energy-query-save.json`) once, with
the server's timezone:

```
sudo docker compose run --rm node node lab/convert-legacy/convert.js energy-query-save.json energy-days.sqlite
```
`GET /api/battery` returns charge/status data or HTTP 503 when unavailable.
Both power and battery responses include `device_charging` with the current
permission (`enabled`), `reason`, measured `socPercent`, `fullSocPercent` and
`maxChargingPowerW`.
Battery level is saved at startup and on each successful background battery poll,
using the `zendure_battery_req_threshold` interval (configured as `20000` ms).
The InfluxDB `battery` measurement contains `socPercent` and, when the device
reports them, `outputHomePower`, `gridInputPower`, `outputPackPower` (charging)
and `packInputPower` (discharging), all in watts. These values come from the same
`/properties/report` request used for battery level, with no extra Zendure call.
Each poll writes one point with the configured `home` tag and the original
battery reading time. Missing or invalid power fields are omitted; zero is saved.
Unavailable or stale readings leave gaps in history. Recording continues even
when house power is unavailable or device charging is blocked.

`GET /api/data/battery/:period` returns battery level history as chronological
`[{"_time": "<ISO timestamp>", "_value": <SOC percent>, "outputHomePower": <watts>,
"gridInputPower": <watts>, "outputPackPower": <watts>, "packInputPower": <watts>}]`
points for the configured home. Power fields are present when recorded; earlier
SOC-only points remain available. For example, `/api/data/battery/24h` returns
the last day, and `/api/data/battery/7d?format=csv` exports all five readings for
the last week, leaving missing values blank. An empty history returns
`[]`; invalid periods return HTTP 400, and database query failures return HTTP 500.
History starts collecting after the application restarts with this version.

`GET /graph/battery/:period` opens the battery history graph with SOC from `0`
to `100` on the percentage axis and the four power series on a separate watts
axis, with time displayed in the configured timezone. Missing power readings
leave gaps in the graph; the new power history begins after restarting with
this version. The dashboard
links to `/graph/battery/24h`; the page also offers two-hour and seven-day views,
a CSV download, and messages for empty history or a failed request.

InfluxDB history uses the selected house source and omits missing solar fields
and network measurements that Zendure does not provide.

The observed 1CT-S response exposes `total_power`, but the official zenSDK
reference does not specify its scaling or sign. Verify `power_scale` against
the Zendure app and a known import/export condition before relying on surplus
power decisions.

### State report

The last button of the dashboard (also shown on the page displayed while the house
power is unavailable) downloads `GET /api/report`: one plain-text file with the
current state of the installation, written to be handed to an AI agent
([`lib/state-report.js`](lib/state-report.js)). Like the dashboard it is public.
It holds, in this order:

1. the Zendure battery: current reading, then its settings and diagnostics;
2. the Zendure sensor (house power meter), or `NOT USED` when `house_power_source`
   is `shelly`;
3. the Shelly energy meters;
4. the device decisions: the battery gate (open or closed and why), the power
   available to the devices, and for each device whether it is on or off, what
   blocks it (forcing, battery gate, maximum energy, control variable target) and
   its last state;
5. the current `devices-to-activate.json`, as it is on disk, with a warning when it
   differs from the devices the running process started with.

Every source is read when the file is requested, in parallel and for at most 5 s.
One that does not answer is written as `NOT CONNECTED` with its error, and the rest
of the report is kept. Units are part of the key names, times are UTC, and a short
legend at the top of the file explains the sign of the house power and how the
decisions are taken. `config.json` is never included, since it holds secrets.

## Standalone Zendure Smart Meter probe

Run the read-only probe from a computer on the meter's LAN, using Node.js 18 or newer.
It uses only built-in modules and does not load the application configuration:

```bash
node try-zendure.js
node try-zendure.js --host 192.168.0.48 --timeout 3000
node try-zendure.js --help
```

The defaults identify the Smart Meter 1CT-S at `192.168.0.48`, serial
`TEE1NJP7P341978`, identity `492848`, fallback MACs `E0:72:A1:85:24:4B` (LAN)
and `E0:72:A1:85:24:48` (WLAN); `zendure_meter` in `config.json` overrides them
when present.
The script tests TCP ports and reads
`/properties/report` and MQTT status over HTTP. It handles both nested zenSDK
properties and the flat 1CT-S response (`total_power`, `a_aprt_power`,
`b_aprt_power`, `c_aprt_power`). It prints raw values without assuming units or
scaling. A response without a serial number cannot confirm the meter's identity.
Exit code 0 means a tested LAN TCP service opened, 1 means none opened, and 2
means invalid options or a failed optional cloud lookup.

If the configured IP returns no meter report (or returns a different serial),
the script looks for the LAN MAC (`--mac`) in the system ARP/neighbor table and
retries at that IP; if the LAN MAC is absent it falls back to the WLAN MAC
(`--wlan-mac`), the address the meter uses on Wi-Fi. If the addresses are not
cached, it makes short TCP connection attempts within the configured IP's `/24`
subnet to populate the table, with at most 16 connections at once; one scan
serves both MACs and the LAN MAC wins when both are found. Only an exact MAC
match is used for recovery, and the output names the interface that matched; the
configured IP is not changed on disk. MAC discovery requires the computer and
meter to be on the same LAN and uses `ip neigh` (or `/proc/net/arp`) on Linux and
`arp` on macOS/Windows. It reports when those facilities are unavailable.

```bash
node try-zendure.js --mac E0:72:A1:85:24:4B --wlan-mac E0:72:A1:85:24:48
node try-zendure.js --no-mac-fallback   # disables both the LAN and the WLAN lookup
```

The supplied authorization key belongs to the cloud API. To also check whether
the meter appears in that API, enter the key without storing it in source or
shell history:

```bash
read -r -s -p 'Zendure key: ' ZENDURE_KEY
echo
export ZENDURE_KEY
node try-zendure.js --cloud
unset ZENDURE_KEY
```

Cloud mode lists matching devices and never prints MQTT credentials. A cloud
match does not establish LAN reachability or provide live readings. Credentials
are accepted only for Zendure's documented HTTPS API host. The local endpoint
is described in [Zendure's zenSDK documentation](https://github.com/Zendure/zenSDK);
cloud authentication follows the [official Home Assistant integration](https://github.com/Zendure/Zendure-HA/blob/master/custom_components/zendure_ha/api.py).
The zenSDK support list names SmartMeter3CT; local 1CT-S readings have been
observed at this IP, but support on other firmware versions is unconfirmed.

Run the probe's focused tests with `node --test test/zendure-probe.test.js`.

## Standalone Zendure battery probe

Read the SolarFlow 3000 MIX AC+ charge level from a computer on its LAN, using
Node.js 18 or newer:

```bash
node try-zendure-battery.js
node try-zendure-battery.js --host 192.168.0.40 --timeout 3000
node try-zendure-battery.js --help
```

Defaults identify the device at `192.168.0.40`, serial `ANACVCDLP283458`,
identity `492766`, MAC `90:64:9B:10:9A:14`, and the built-in battery (Akku 1)
with serial `BEAAVCDLA283460`. The probe shares the meter's network, MAC recovery,
credential redaction and optional cloud lookup helpers. It uses only Node.js
built-in modules and does not load the application configuration.

The script reads `/properties/report` and MQTT status, then displays:

* Current charge percentage from the exact matching battery's `packData.socLevel`.
* Device average charge from `properties.electricLevel`, used as a fallback when
  the expected pack's charge percentage is unavailable.
* Battery charging power (`outputPackPower`) and discharging power
  (`packInputPower`) in watts, plus the matching pack's own `power` reading.
* Battery state: standby, charging or discharging, with device and pack serial
  verification reported separately.

These fields follow [Zendure's SolarFlow property reference](https://github.com/Zendure/zenSDK/blob/main/docs/en_properties.md).
The supplied MIX AC+ returned both serials and these fields during a local check.
Pack power and device charging power are distinct measurements and are shown
separately. A different device serial or `dataReady: 0` prevents the response from
being used as a current charge reading. If the expected pack is absent, any
available charge percentage is explicitly labelled as the device average.
No charging commands or configuration changes are sent.

The battery probe supports `--battery-serial`, `--mac`, `--no-mac-fallback`,
`--serial`, `--id`, `--ports`, `--timeout`, and `--cloud` with the same
`ZENDURE_KEY` setup described above. Cloud mode only lists matching devices;
it does not supply a live charge percentage. Exit code 0 means a usable LAN charge
reading was received, 1 means none was received (even if a TCP service opened),
and 2 means invalid options or a failed optional cloud lookup.

```bash
node --test test/zendure-battery-probe.test.js
```

## TODO

* Add documentation on config files
* Add a night mode in order to prevent calculation and communications during night
* Add a UI to configure the system
* Improve the debug system to adapt the period of request to the value

## Exec bash on container

```
docker exec -it solar-panel-watch-node-1 /bin/sh
```

## Device Disconnection Mechanism in `is_device_connected`

The is_device_connected function checks if a device is still connected to a server based on the time of its last call. If the elapsed time since the last call is less than 50 times the `time_limit value`, the function returns true, indicating that the device is still connected. Otherwise, the function returns false, indicating that the device is disconnected.

The mechanism for device disconnection in this function is based on the assumption that a device should make regular calls to the server within a certain time frame. If the device fails to make a call within that time frame, it is considered disconnected. The time frame is determined by the  `time_limit` parameter, which represents the time in milliseconds between device calls to the server. The maximum allowed time between calls is 50 times the `time_limit` value, which is calculated in the function as `max_allowed_time = 50 * time_limit`.

When the `is_device_connected` function is called, it first calculates the elapsed time since the device's last call using the `Date.now()` method to get the current time in milliseconds since the epoch and subtracting `last_call` from it. If the elapsed time is less than max_allowed_time, the function returns true, indicating that the device is still connected. Otherwise, the function returns false, indicating that the device is disconnected.

By checking if a device has made a call to the server within a certain time frame, the `is_device_connected` function provides a simple and effective mechanism for determining if a device is still connected to a server. This mechanism can be used to trigger appropriate actions or alerts when a device is disconnected from a server.
