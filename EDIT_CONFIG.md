# Editing devices-to-activate.json on the server

`devices-to-activate.json` sets how each controlled device is driven. The app
reads it once at startup (`require` in `main.js`), so a change only applies
after a restart. Unlike `config.json`, which has its own editor at `/config/`
(see the README), this file is tracked by git and has no web editor.

| | |
| --- | --- |
| Server | `cjung@home.cedric-jung.eu` |
| Checkout | `~/repos/solar-panel-watch` (`/home/cjung/repos/solar-panel-watch`, not `/repos`) |
| App | compose service `node` of `docker-compose.yml`, host network, port `8889` |

The server has `jq`, `python3`, `curl` and `git`. Node only exists inside the
container, so `node -e` does not work on the host.

## Procedure

Run these commands from your computer:

```bash
SERVER=cjung@home.cedric-jung.eu
REPO=repos/solar-panel-watch   # relative to the home directory

# 1. Keep a dated backup on the server
ssh $SERVER "cd $REPO && cp -p devices-to-activate.json devices-to-activate.json.bak-$(date +%Y%m%d)"

# 2. Download the current file
scp $SERVER:$REPO/devices-to-activate.json ./devices-to-activate.server.json

# 3. Edit devices-to-activate.server.json, then check that it is valid JSON
#    and that the diff only shows what you meant to change
python3 -m json.tool devices-to-activate.server.json > /dev/null && echo "valid JSON"
ssh $SERVER "cat $REPO/devices-to-activate.json" | diff - devices-to-activate.server.json

# 4. Copy it back and check the result on the server
scp devices-to-activate.server.json $SERVER:$REPO/devices-to-activate.json
ssh $SERVER "cd $REPO && jq -c '.[] | {uri, power_threshold_percentage}' devices-to-activate.json && git diff devices-to-activate.json"

# 5. Restart the app so it reads the file
ssh $SERVER "cd $REPO && sudo docker compose restart node"

# 6. Check the value the running app uses
ssh $SERVER "curl -s localhost:8889/api/device/chauffe-eau/debug/ | jq .power_threshold_percentage"
```

Instead of step 5, you can restart from the `/config/` page (login needed).
After a restart, devices that are not forced may stay off for a few seconds
until they call the app again. Forced levels are reloaded from `reload_files/`.
The energy-limit and temperature-target flags start cleared and are set again
by their next periodic check.

## Rollback

```bash
ssh $SERVER "cd $REPO && cp -p devices-to-activate.json.bak-YYYYMMDD devices-to-activate.json && sudo docker compose restart node"
```

`git checkout devices-to-activate.json` on the server also restores the
committed values.

## Keeping git in step

The edit leaves the server checkout modified. A later `git pull` that also
changes this file stops with "Your local changes would be overwritten". Commit
the same values in the repository, then on the server run
`git checkout devices-to-activate.json && git pull`, and check the values
again.

## The margin: `power_threshold_percentage`

`power_limit × power_threshold_percentage` is the export the app leaves on the
grid for that device:

- **Advanced devices** (dimmer, `alpha`) take the surplus minus this margin.
- **Normal devices** (on/off) start when the surplus reaches `power_limit` and
  stay on while it is above the margin.

Devices are served in priority order. A lower-priority device gets what the
previous one left, minus its own margin. Keep each lower-priority margin at
least as large as the margin before it. Otherwise that device runs on the
difference, a few watts, and keeps switching on and off.

The SolarFlow cuts its own charging when export falls below about 100 W. The
battery rule (see `261015-battery-logic.md`) then reads "charging below max"
and turns the devices off. A margin above that band keeps the battery at its
maximum while the devices run.

## Change log

| Date | Device | `power_threshold_percentage` | Margin | Reason |
| --- | --- | --- | --- | --- |
| 2026-10-24 | `chauffe-eau` | 0.04 → 0.10 | 104 → 260 W | The heater switched off about twice a minute: each small battery dip closed the "charging at max" check. |
| 2026-10-24 | `chauffe-eau-sanitaire` | 0.04 → 0.12 | 92 → 276 W | It ran on the 12 W left between the two margins and switched 115 times in 16 minutes. |
