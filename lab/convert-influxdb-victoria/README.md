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

Both take `--start` / `--stop` (dates like `2026-01-31T00:00:00Z`; default: all
the data of the bucket), `--victoria-url` (default `http://127.0.0.1:8428`) and
`--influx-url`, `--influx-token`, `--influx-org`, `--influx-bucket` (default:
the settings of the former `docker-compose.yml`). Running `convert.js` again
over the same days does no harm: VictoriaMetrics, started with
`-dedup.minScrapeInterval=1ms`, keeps one sample per timestamp.

`influxd inspect export-lp` is not used: it dumps the storage files as they are,
with the points that later writes replaced (7 % more points than InfluxDB
returns, for the last day tried).

## Try it on this machine with a backup of the server

1. Put the InfluxDB backup in the volume of the former `influxdb` service and
   start an InfluxDB on it (the volume holds the users and tokens too):

   ```bash
   docker run --rm -v solar-panel-watch_data:/data -v "$PWD":/backup alpine \
       sh -c 'rm -rf /data/* && tar xzf /backup/influx-data.tgz -C /data'
   docker run -d --name influx-migration --network host -v solar-panel-watch_data:/var/lib/influxdb2 influxdb:2.6-alpine
   ```

2. Start VictoriaMetrics, copy, check:

   ```bash
   docker compose up -d victoriametrics
   node lab/convert-influxdb-victoria/convert.js
   node lab/convert-influxdb-victoria/verify.js
   ```

3. Stop InfluxDB: `docker rm -f influx-migration`.

On this machine (2026-10-28, the server's backup: 22 million points from
2025-12-19 to 2026-10-28), the copy took 7 min 20 s at the default rate, with
VictoriaMetrics at 124 MiB and InfluxDB at 133 MiB of memory at most, and
`verify.js` passed in 11 s. The only differences are 1 461 `power1`/`power2`
points written twice less than 1 ms apart (same values), now one sample each.
VictoriaMetrics' data takes 63 MB on disk, against 252 MB for the InfluxDB bucket.

## Migrate the server

The server has 746 MiB of memory and no swap; InfluxDB, VictoriaMetrics, the app
and the copy run together for a few minutes.

1. Back up InfluxDB as before (the volume `solar-panel-watch_data`):

   ```bash
   docker compose stop influxdb
   sudo tar czf ~/influx-data.tgz -C /var/lib/docker/volumes/solar-panel-watch_data/_data .
   docker compose start influxdb
   ```

2. Update the code and start it: `git pull`, then `docker compose up -d`. This
   starts VictoriaMetrics and the app, which writes there from now on. The
   former `influxdb` container keeps running (Compose warns about an orphan
   container), and the first start renames the InfluxDB settings of
   `config.json` (the previous file is kept as `config.json.bak`).

3. Copy the history, at a lower rate to spare the memory, and check it:

   ```bash
   docker compose run --rm --no-deps node node lab/convert-influxdb-victoria/convert.js --max-rate 20000
   docker compose run --rm --no-deps node node lab/convert-influxdb-victoria/verify.js
   ```

   The last day can differ by the readings InfluxDB received during the switch.

4. Remove InfluxDB: `docker compose up -d --remove-orphans`. Keep the volume
   `solar-panel-watch_data` (or `~/influx-data.tgz`) until the new history has
   been checked, then `docker volume rm solar-panel-watch_data`.

The stored energy days (`energy-days.sqlite`) do not change. A day computed
during the copy, before its readings arrived, is partial and computed again.
