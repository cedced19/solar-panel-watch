# Editing devices-to-activate.json on the server

`devices-to-activate.json` sets how each controlled device is driven. The app
reads it once at startup (`require` in `main.js`), so a change only applies
after a restart. The file is local to the installation and not tracked by git,
like `config.json`: `devices-to-activate-default.json` is the tracked template
it is created from when missing, and later changes to the template never reach
an existing file.

## In the browser

Open `/config/`, sign in, choose the `devices-to-activate.json` tab, edit the
form (or the JSON tab to add or remove a device) and save. The previous version
is kept in `devices-to-activate.json.bak`. A file the app could not start with
(missing `power_limit`, duplicate `uri`, ...) is refused. Then press **Restart**
in the banner that appears.

After a restart, devices that are not forced may stay off for a few seconds
until they call the app again. Forced levels are reloaded from `reload_files/`.
The energy-limit and temperature-target flags start cleared and are set again
by their next periodic check.

## On the server, over SSH

Use this when the app does not start or the page cannot be reached.

| | |
| --- | --- |
| Server | `cjung@home.cedric-jung.eu` |
| Checkout | `~/repos/solar-panel-watch` (`/home/cjung/repos/solar-panel-watch`, not `/repos`) |
| App | compose service `node` of `docker-compose.yml`, host network, port `8889` |

The server has `jq`, `python3`, `curl` and `git`. Node only exists inside the
container, so `node -e` does not work on the host.

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
ssh $SERVER "cd $REPO && jq -c '.[] | {uri, power_threshold_percentage}' devices-to-activate.json"

# 5. Restart the app so it reads the file
ssh $SERVER "cd $REPO && sudo docker compose restart node"

# 6. Check the value the running app uses
ssh $SERVER "curl -s localhost:8889/api/device/chauffe-eau/debug/ | jq .power_threshold_percentage"
```

Rollback:

```bash
ssh $SERVER "cd $REPO && cp -p devices-to-activate.json.bak-YYYYMMDD devices-to-activate.json && sudo docker compose restart node"
```

Deleting `devices-to-activate.json` and restarting recreates it from
`devices-to-activate-default.json`, which holds the values committed in the
repository, not the ones tuned on the server (see the change log below).

## Updating the server from a checkout that still tracks the file

Until the commit that untracks `devices-to-activate.json` is pulled, the server
checkout has it tracked and modified, and `git pull` stops with "Your local
changes would be overwritten". Once, on the server:

```bash
cd ~/repos/solar-panel-watch
cp -p devices-to-activate.json devices-to-activate.local.json
git checkout devices-to-activate.json && git pull
mv devices-to-activate.local.json devices-to-activate.json
sudo docker compose restart node
```

Afterwards `git pull` never touches the file again.

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
