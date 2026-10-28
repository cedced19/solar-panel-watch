# InfluxDB backup / restore

## Create the backup on the server

Stop the container first so the data files are in a consistent state:

```bash
docker compose stop influxdb
```

Archive the InfluxDB data volume and fix the ownership so it can be copied:

```bash
sudo tar czf ~/influx-data.tgz -C /var/lib/docker/volumes/solar-panel-watch_data/_data .
sudo chown cjung: ~/influx-data.tgz
```

Restart the container:

```bash
docker compose start influxdb
```

## Copy the archive to this machine

From this repository folder (`/home/cjung/perso/solar-panel-watch`):

```bash
scp cjung@home.cedric-jung.eu:~/influx-data.tgz .
```

## Restore (on a machine with the same compose project)

```bash
docker compose stop influxdb
sudo rm -rf /var/lib/docker/volumes/solar-panel-watch_data/_data/*
sudo tar xzf influx-data.tgz -C /var/lib/docker/volumes/solar-panel-watch_data/_data
docker compose start influxdb
```
