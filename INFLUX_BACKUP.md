# InfluxDB backup / restore

## Create the backup on the server

Stop the container first so the data files are in a consistent state:

```bash
docker compose stop influxdb
```

Archive the InfluxDB data volume and fix the ownership so it can be copied:

```bash
sudo tar czf ~/influx-data.tgz -C "$(docker volume inspect -f '{{.Mountpoint}}' solar-panel-watch_data)" .
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

The volume path depends on how Docker is installed (`/var/lib/docker/...` for a normal install,
`/var/snap/docker/common/var-lib-docker/...` for the snap package), so ask Docker for it.
The `rm` glob must run inside `sudo sh -c`: the folder is root-only, so your own shell cannot expand `*`.

```bash
docker compose stop influxdb
VOL=$(docker volume inspect -f '{{.Mountpoint}}' solar-panel-watch_data)
sudo sh -c "rm -rf $VOL/*"
sudo tar xzf influx-data.tgz -C "$VOL"
docker compose start influxdb
```
