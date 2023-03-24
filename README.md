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
sudo docker compose -f docker-compose-npm-install.yml up
```

to remove volume:
```
sudo docker volume rm solar-panel-watch_data
```

## TODO

* Add documentation on config files
* Add a night mode in order to prevent calculation and communications during night
* Add a UI to configure the system
* Improve the debug system to adapt the period of request to the value

## Device Disconnection Mechanism in `is_device_connected`

The is_device_connected function checks if a device is still connected to a server based on the time of its last call. If the elapsed time since the last call is less than 50 times the `time_limit value`, the function returns true, indicating that the device is still connected. Otherwise, the function returns false, indicating that the device is disconnected.

The mechanism for device disconnection in this function is based on the assumption that a device should make regular calls to the server within a certain time frame. If the device fails to make a call within that time frame, it is considered disconnected. The time frame is determined by the  `time_limit` parameter, which represents the time in milliseconds between device calls to the server. The maximum allowed time between calls is 50 times the `time_limit` value, which is calculated in the function as `max_allowed_time = 50 * time_limit`.

When the `is_device_connected` function is called, it first calculates the elapsed time since the device's last call using the `Date.now()` method to get the current time in milliseconds since the epoch and subtracting `last_call` from it. If the elapsed time is less than max_allowed_time, the function returns true, indicating that the device is still connected. Otherwise, the function returns false, indicating that the device is disconnected.

By checking if a device has made a call to the server within a certain time frame, the `is_device_connected` function provides a simple and effective mechanism for determining if a device is still connected to a server. This mechanism can be used to trigger appropriate actions or alerts when a device is disconnected from a server.
