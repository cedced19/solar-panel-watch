# solar-panel-watch
Watch over electricity consumption from my house.

![Demo](demo.png)

## config.json

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
    "energy_req_threshold": 1200000,
    "target_req_threshold": 240000,
    "force_mode_pass": "7HaIJtG44d"
}
```

## devices-to-activate.json
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

## Standalone Zendure Smart Meter probe

Run the read-only probe from a computer on the meter's LAN, using Node.js 18 or newer.
It uses only built-in modules and does not load the application configuration:

```bash
node try-zendure.js
node try-zendure.js --host 192.168.0.48 --timeout 3000
node try-zendure.js --help
```

The defaults identify the Smart Meter 1CT-S at `192.168.0.48`, serial
`TEE1NJP7P341978`, identity `492848`, fallback MAC `E0:72:A1:85:24:48`.
The script tests TCP ports and reads
`/properties/report` and MQTT status over HTTP. It handles both nested zenSDK
properties and the flat 1CT-S response (`total_power`, `a_aprt_power`,
`b_aprt_power`, `c_aprt_power`). It prints raw values without assuming units or
scaling. A response without a serial number cannot confirm the meter's identity.
Exit code 0 means a tested LAN TCP service opened, 1 means none opened, and 2
means invalid options or a failed optional cloud lookup.

If the configured IP returns no meter report (or returns a different serial),
the script finds the fallback MAC in the system ARP/neighbor table and retries
at that IP. If the address is not cached, it makes short TCP connection attempts
within the configured IP's `/24` subnet to populate the table, with at most 16
connections at once. Only an exact MAC match is used for recovery; the configured
IP is not changed on disk. MAC discovery requires the computer and meter to be
on the same LAN and uses `ip neigh` (or `/proc/net/arp`) on Linux and `arp` on
macOS/Windows. It reports when those facilities are unavailable.

```bash
node try-zendure.js --mac E0:72:A1:85:24:48
node try-zendure.js --no-mac-fallback
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
