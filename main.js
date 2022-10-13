

const express = require('express');
const favicon = require('express-favicon');
const path = require('path');
const logger = require('morgan');
const compress = require('compression');
const minifyTemplate = require('express-beautify').minify;
const {InfluxDB} = require('@influxdata/influxdb-client');
const JSONStore = require('json-store-list');
const db_energy = JSONStore('./energy-query-save.json');
const config = require('./config.json');
const getInformations = require('./get-informations.js');
const daemonInflux = require('./daemon-influx.js');
const compute_energy = require('./compute-energy.js');


// Express App
const app = express();

const port = require('env-port')('8889');
app.set('port', port);

const i18n = require('./i18n');

app.use(favicon(path.join(__dirname, 'assets','favicon.ico')));

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(i18n.init);

if (app.get('env') === 'development') {
    app.use(logger('dev'));
} else {
    app.use(compress());
    app.use(minifyTemplate());
}

app.use('/assets/', express.static('assets'));

app.get('/', function(req, res) {
    getInformations.req(function (err, data) {
        if (err) return res.render('index', {error: true});
        res.render('index', {
            error: false,
            power1: data.emeters[0].power,
            power2: data.emeters[1].power
        });
    });
});

app.get('/graph/power/:period', function(req, res) {
    res.render('graph-power', {
        period: req.params.period,
        timezone: config.timezone
    });
});

app.get('/energy/:period', function(req, res) {
    res.render('energy', {
        period: req.params.period,
        timezone: config.timezone
    });
});

app.get('/energy-hist/', function(req, res) {
    res.render('energy-request-hist', {
        timezone: config.timezone
    });
});

app.get('/activation-hist/', function(req, res) {
    res.render('activation-hist', {
        timezone: config.timezone
    });
});

app.get('/graph/power/:period/group-by/:group/', function(req, res) {
    res.render('graph-power-group', {
        period: req.params.period,
        group: req.params.group,
        timezone: config.timezone
    });
});

app.get('/api/data', function(req, res) {
    getInformations.req(function (err, data) {
        if (err) return next(err);
        res.json({
            power1: data.emeters[0].power,
            power2: data.emeters[1].power
        });
    });
});

const token = config.influx_tocken;
const org = config.influx_org;
const bucket = config.influx_bucket;
const defaultTag = config.influx_default_tag;
const url = config.influx_url;
const client = new InfluxDB({url: url, token: token});
const queryApi = client.getQueryApi(org);
app.get('/api/data/power/:tag/:period', (req, res, next) => {
    let csv = []
    const query = 
    `from(bucket: "${bucket}")
    |> range(start: -${req.params.period})
    |> filter(fn: (r) => r["_measurement"] == "power")
    |> filter(fn: (r) => r["_field"] == "${req.params.tag}")
    |> yield(name: "mean")`

    queryApi.queryRows(query, {
        next(row, tableMeta) {
          o = tableMeta.toObject(row);
          csv.push(o);
        },
        error(error) {
            error.status = 500;
            res.status(500);
            next(error);
        },
        complete() {
          res.json(csv);
        },
    });
});

function requestDataForEnergy(period, tag) {
    return new Promise(function(resolve, reject) {
        let csv = []
            const query = 
            `from(bucket: "${bucket}")
            |> range(start: -${period})
            |> filter(fn: (r) => r["_measurement"] == "power")
            |> filter(fn: (r) => r["_field"] == "${tag}")
            |> yield(name: "mean")`

            queryApi.queryRows(query, {
                next(row, tableMeta) {
                    o = tableMeta.toObject(row);
                    csv.push(o);
                },
                reject,
                complete() {
                    resolve(csv);
                }
            });
    });
}

app.get('/api/data/energy/:period', (req, res, next) => {
    const promises = [requestDataForEnergy(req.params.period, 'power1'), requestDataForEnergy(req.params.period, 'power2')];
    Promise.all(promises).then(function (data) {
        try {
            let energy_data = compute_energy(data[0],data[1]);
            res.json(energy_data);
            db_energy.post({date: new Date(), period: req.params.period, result: energy_data}, function (error) {
                if (error) return console.error(error)
            });
        } catch (error) {
            error.status = 500;
            res.status(500);
            next(error);
        }
    }, function (error) {
        error.status = 500;
        res.status(500);
        next(error);
    });
});

app.get('/api/data/energy-request-hist/', (req, res) => {
    res.json(db_energy.getAll())
});

app.get('/api/data/power/:tag/:period/group-by/:group/', (req, res) => {
    let csv = []
    const query = 
    `from(bucket: "${bucket}")
    |> range(start: -${req.params.period})
    |> filter(fn: (r) => r["_measurement"] == "power")
    |> filter(fn: (r) => r["_field"] == "${req.params.tag}")
    |> aggregateWindow(fn: mean, every: ${req.params.group}, createEmpty: false)`

    queryApi.queryRows(query, {
        next(row, tableMeta) {
          o = tableMeta.toObject(row);
          csv.push(o);
        },
        error(error) {
          console.error(error);
          res.end();
        },
        complete() {
          res.json(csv);
        },
      });
});

const devicesToActivate = require('./devices-to-activate.json');
const devicesToActivateState = {};
const db_devices_activation = JSONStore('./devices-activation.json');
app.get('/api/device/:name/', (req, res, next) => {
    let element = devicesToActivate.filter(value => {
        return value.uri == req.params.name;
    });
    if (element.length > 0) {
        let device = element[0];
        // make sure that device state exists
        if (!devicesToActivateState.hasOwnProperty(device.uri)) {
            devicesToActivateState[device.uri] = {activated: false, last_call: (new Date()).getTime()}
        }
        getInformations.get_moving_average_power(0, function (err, power) {
            if (err) return next(err);
            toActivate = false;
            if ((devicesToActivateState[device.uri].activated == true) && (devicesToActivateState[device.uri].last_call + device.time_limit < (new Date()).getTime() + 1000)) {
                if (-power > device.limit*0.10) {
                    toActivate = true;
                } else {
                    toActivate = false;
                }
            } else {
                if (-power > device.limit) {
                    toActivate = true;
                } else {
                    toActivate = false;
                }
            }
            devicesToActivateState[device.uri].last_call = (new Date()).getTime();
            res.json({toggle: toActivate, time_limit: device.time_limit});
            if (toActivate != devicesToActivateState[device.uri].activated) {
                db_devices_activation.post({uri: device.uri, activated: toActivate, time: devicesToActivateState[device.uri].last_call}, function() {});
            }
            devicesToActivateState[device.uri].activated = toActivate; 
        });
    } else {
        let err = new Error('Device cannot be found.');
        err.status = 404;
        res.status(404);
        next(err);
    }
});

app.get('/api/device/:name/debug/', (req, res, next) => {
    let element = devicesToActivate.filter(value => {
        return value.uri == req.params.name;
    });
    if (element.length > 0) {
        let device = element[0];
        // make sure that device state exists
        if (!devicesToActivateState.hasOwnProperty(device.uri)) {
            devicesToActivateState[device.uri] = {activated: false, last_call: (new Date()).getTime()}
        }
        getInformations.get_moving_average_power(0, function (err, power) {
            if (err) return next(err);
            toActivate = false;
            if ((devicesToActivateState[device.uri].activated == true) && (devicesToActivateState[device.uri].last_call + device.time_limit < (new Date()).getTime() + 1000)) {
                if (-power > device.limit*0.10) {
                    toActivate = true;
                } else {
                    toActivate = false;
                }
            } else {
                if (-power> device.limit) {
                    toActivate = true;
                } else {
                    toActivate = false;
                }
            }
            res.json({
                activated: devicesToActivateState[device.uri].activated, 
                toggle: toActivate, 
                time_limit: device.time_limit, 
                limit: device.limit,
                last_call: devicesToActivateState[device.uri].last_call, 
                last_call_str: (new Date(devicesToActivateState[device.uri].last_call)).toGMTString(), 
                power: -power,
                info_type: 'debug'
            });
        });
    } else {
        let err = new Error('Device cannot be found.');
        err.status = 404;
        res.status(404);
        next(err);
    }
});

app.get('/device/:device_name', (req, res, next) => {
    res.render('debug-device', {
        timezone: config.timezone,
        device_name: req.params.device_name
    });
});

app.get('/api/data/activation-hist/', (req, res) => {
    res.json(db_devices_activation.getAll())
});

app.use(function (req, res, next) {
    var err = new Error('Element cannot be found.');
    err.status = 404;
    res.status(404);
    next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use(function (err, req, res, next) {
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            status: err.status || 500,
            error: err
        });
    });
}

// production error handler
// no stacktraces leaked to user
app.use(function (err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        status: err.status || 500, 
        error: {}
    });
});


app.listen(port, () => {
    console.log(require('server-welcome')(port, 'Solar panel watch'));
});

// Write data
setInterval(function () {
    daemonInflux(app.get('env') === 'development');
},config.influx_update_delay)