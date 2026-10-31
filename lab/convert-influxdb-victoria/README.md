# InfluxDB → VictoriaMetrics

Tools to copy the history of the former InfluxDB 2.x bucket into VictoriaMetrics
and to check the copy. They need Node 18 or later and no npm package.

- `convert.js` reads the bucket a day at a time through InfluxDB's HTTP API
  (Flux) and writes each point to VictoriaMetrics as the app does: the field
  `<field>` of `<measurement>` becomes the metric `<measurement>_<field>`, the
  tags (`home`) become labels, timestamps are cut to the millisecond. Points
  that are not numbers are skipped (the bucket has none). It writes at most
  `--max-rate` points per second (default 50 000): unthrottled, VictoriaMetrics
  takes about 200 000 points per second, its buffer of pending rows outgrows the
  250m container and the kernel kills it.
- `verify.js` compares, for every series and every UTC day, the number of points
  and their sum in both databases. It exits with code 1 when they differ.
- `docker-compose.yml` turns a backup of InfluxDB (`influx-data.tgz`) into a
  backup of VictoriaMetrics (`victoria-data.tgz`) with both tools, on a machine
  with more memory than the server (below).

Both scripts take `--start` / `--stop` (dates like `2026-01-31T00:00:00Z`;
default: all the data of the bucket), `--victoria-url` (default
`http://127.0.0.1:8428`) and `--influx-url`, `--influx-token`, `--influx-org`,
`--influx-bucket` (default: the settings of the former `docker-compose.yml`).
Running `convert.js` again over the same days does no harm: VictoriaMetrics,
started with `-dedup.minScrapeInterval=1ms`, keeps one sample per timestamp.

`influxd inspect export-lp` is not used: it dumps the storage files as they are,
with the points that later writes replaced (7 % more points than InfluxDB
returns, for the last day tried).

## Convert a backup on this machine

`docker-compose.yml` is a project of its own (`convert-influxdb-victoria`): its
InfluxDB and VictoriaMetrics have their own network and volumes, so the app's
containers keep running. Its containers take at most 4 GiB of memory together
(InfluxDB 1 GiB, VictoriaMetrics 2 GiB, the copy 1 GiB). From this folder:

```bash
docker compose run --rm convert
docker compose down -v
```

The first command unpacks `../../influx-data.tgz` (the repository root, where
[INFLUX_BACKUP.md](../../INFLUX_BACKUP.md) copies it), starts InfluxDB on it and
an empty VictoriaMetrics with the app's storage flags, copies every point at
200 000 points per second, runs `verify.js`, and writes a snapshot of
VictoriaMetrics' storage to `../../victoria-data.tgz`. That archive is restored
like a backup of the server ([VICTORIA_BACKUP.md](../../VICTORIA_BACKUP.md)). The
command fails, and writes nothing, when the copy differs. The second command
removes the containers and their volumes.

Other files: `INFLUX_BACKUP=/path/to/influx-data.tgz` and
`OUTPUT_DIR=/path/to/folder` before `docker compose run` (relative paths start
from this folder). The logs of the databases: `docker compose logs influxdb
victoriametrics`.

On this machine (2026-10-31, the server's backup: 24 million points from
2025-12-19 to 2026-10-31), the whole run took 2 min 20 s, with VictoriaMetrics
at 783 MiB, InfluxDB at 137 MiB and the copy at 91 MiB of memory at most. The
archive takes 46 MB. The only differences are 1 461 `power1`/`power2` points
written twice less than 1 ms apart (same values), now one sample each. The
archive, restored into a new VictoriaMetrics, passed `verify.js` too.

## Migrate the server

The server has 746 MiB of memory and no swap: the history is converted here and
only the readings InfluxDB receives after the backup are copied on the server.

1. Back up InfluxDB and copy the archive here, as in
   [INFLUX_BACKUP.md](../../INFLUX_BACKUP.md). InfluxDB and the app keep running.

2. Convert it here (above) and copy the result to the server:

   ```bash
   scp victoria-data.tgz cjung@home.cedric-jung.eu:~/
   ```

3. On the server, update the code, create the new containers and volume
   without starting them (this stops the app), restore the archive, start:

   ```bash
   git pull
   docker compose up --no-start
   docker run --rm -v solar-panel-watch_victoria-data:/data -v ~:/backup alpine \
       sh -c 'rm -rf /data/* && tar xzf /backup/victoria-data.tgz -C /data'
   docker compose up -d
   ```

   The app writes to VictoriaMetrics from now on. The former `influxdb`
   container keeps running (Compose warns about an orphan container), and the
   first start renames the InfluxDB settings of `config.json` (the previous
   file is kept as `config.json.bak`).

4. Copy the readings InfluxDB received between the backup and the switch, from
   the day of the backup (here 2026-10-31; copying a day again is harmless),
   and check them:

   ```bash
   docker compose run --rm --no-deps node node lab/convert-influxdb-victoria/convert.js --start 2026-10-31T00:00:00Z --max-rate 20000
   docker compose run --rm --no-deps node node lab/convert-influxdb-victoria/verify.js --start 2026-10-31T00:00:00Z
   ```

   The day of the switch differs: VictoriaMetrics also holds the readings the
   app wrote since.

5. Remove InfluxDB: `docker compose up -d --remove-orphans`. Keep the volume
   `solar-panel-watch_data` (or `~/influx-data.tgz`) until the new history has
   been checked, then `docker volume rm solar-panel-watch_data`.

The stored energy days (`energy-days.sqlite`) do not change. A day computed
before its readings were copied is partial and computed again.
