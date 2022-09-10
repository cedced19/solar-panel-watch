

const express = require('express');
const favicon = require('express-favicon');
const path = require('path');
const logger = require('morgan');
const compress = require('compression');
const minifyTemplate = require('express-beautify').minify;
const {InfluxDB} = require('@influxdata/influxdb-client');
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
    getInformations(function (err, data) {
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

app.get('/graph/power/:period/group-by/:group/', function(req, res) {
    res.render('graph-power-group', {
        period: req.params.period,
        group: req.params.group,
        timezone: config.timezone
    });
});

app.get('/api/data', function(req, res) {
    getInformations(function (err, data) {
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
            res.json(compute_energy(data[0],data[1]));
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

app.use(function (req, res, next) {
    var err = new Error('Element cannot be find.');
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
    //daemonInflux(app.get('env') === 'development')
},config.influx_update_delay)