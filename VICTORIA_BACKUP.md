# VictoriaMetrics backup / restore

The readings live in the Docker volume `solar-panel-watch_victoria-data`. The
commands below read and write it through a throwaway `alpine` container, so they
work whatever the host path of Docker's volumes is.

## Create the backup on the server

Stop the container first so the data files are in a consistent state. Meanwhile
the app keeps its readings in memory and sends them once VictoriaMetrics is back:

```bash
docker compose stop victoriametrics
docker run --rm -v solar-panel-watch_victoria-data:/data:ro -v ~:/backup alpine \
    tar czf /backup/victoria-data.tgz -C /data .
docker compose start victoriametrics
```

## Copy the archive to this machine

From this repository folder (`/home/cjung/perso/solar-panel-watch`):

```bash
scp cjung@home.cedric-jung.eu:~/victoria-data.tgz .
```

## Restore (on a machine with the same compose project)

```bash
docker compose stop victoriametrics
docker run --rm -v solar-panel-watch_victoria-data:/data -v "$PWD":/backup alpine \
    sh -c 'rm -rf /data/* && tar xzf /backup/victoria-data.tgz -C /data'
docker compose start victoriametrics
```

An InfluxDB backup (`influx-data.tgz`) from before the switch is converted with
the tools in [lab/convert-influxdb-victoria](lab/convert-influxdb-victoria/README.md).
