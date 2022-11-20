

const express = require('express');
const favicon = require('express-favicon');
const path = require('path');
const logger = require('morgan');
const compress = require('compression');
const minifyTemplate = require('express-beautify').minify;

const getInformations = require('./lib/get-informations.js');
const getAlpha = require('./lib/get-alpha.js');
const influxLib = require('./lib/influx-lib.js');
const computeEnergy = require('./lib/compute-energy.js');


const JSONStore = require('json-store-list');

const config = require('./config.json');

const db_energy = JSONStore('./energy-query-save.json');

const devices_to_activate = require('./devices-to-activate.json');
const devices_to_activate_state = {};
const db_devices_activation = JSONStore('./devices-activation.json');

function get_power_from_activated_devices() {
    let sum = 0;
    for (let device in devices_to_activate_state) {
        sum += devices_to_activate_state[device].last_power
    }
    return sum;
}

// Express App
const app = express();

const port = require('env-port')('8889');
app.set('port', port);

const i18n = require('./lib/i18n');

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
            power2: data.emeters[1].power,
            power_activated_device: get_power_from_activated_devices()
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

app.get('/graph/power/:period/activation-hist-plot/', function(req, res) {
    res.render('graph-power-activation-hist', {
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

app.get('/api/data', function(req, res) {
    getInformations.req(function (err, data) {
        if (err) return next(err);
        res.json({
            power1: data.emeters[0].power,
            power2: data.emeters[1].power,
            power_activated_device: get_power_from_activated_devices()
        });
    });
});

app.get('/api/data/power/:tag/:period', (req, res, next) => {
    influxLib.requestDataOverPeriod(req.params.period, req.params.tag).then(function (data) {
        res.json(data);
    }, function (error) {
        error.status = 500;
        res.status(500);
        next(error);
    });
});

app.get('/api/data/energy/:period', (req, res, next) => {
    const promises = [influxLib.requestDataOverPeriod(req.params.period, 'power1'), influxLib.requestDataOverPeriod(req.params.period, 'power2')];
    Promise.all(promises).then(function (data) {
        try {
            let energy_data = computeEnergy(data[0],data[1]);
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
    db_energy.save(function () {
        res.json(db_energy.getAll());
    });
});

app.get('/api/data/power/:tag/:period/group-by/:group/', (req, res, next) => {
    influxLib.requestDataOverPeriodGroupBy(req.params.period, req.params.tag, req.params.group).then(function (data) {
        res.json(data);
    }, function (error) {
        error.status = 500;
        res.status(500);
        next(error);
    });
});

function normalDecision(device, power, cb) {
    to_activate= false;
    if ((devices_to_activate_state[device.uri].activated == true) && (devices_to_activate_state[device.uri].last_call + device.time_limit < (new Date()).getTime() + 1000)) {
        if (-power > device.power_limit*device.power_threshold_percentage) {
            to_activate= true;
        } else {
            to_activate= false;
        }
    } else {
        if (-power > device.power_limit) {
            to_activate = true;
        } else {
            to_activate = false;
        }
    }
    devices_to_activate_state[device.uri].last_power = (to_activate) ? device.power_limit  : 0;
    cb(to_activate);
}

function normalDecisionReq(device, res) {
    // make sure that device state exists
    if (!devices_to_activate_state.hasOwnProperty(device.uri)) {
        devices_to_activate_state[device.uri] = {activated: false, activated_advanced: false, last_call: (new Date()).getTime(), last_power: device.power_limit }
    }
    getInformations.get_moving_average_power(0, function (err, power) {
        if (err) return next(err);
        normalDecision(device, power.average, function (to_activate) {
            res.json({toggle: to_activate, time_limit: device.time_limit});
            devices_to_activate_state[device.uri].last_call = (new Date()).getTime();
            if (to_activate!= devices_to_activate_state[device.uri].activated) {
                db_devices_activation.post({uri: device.uri, activated: to_activate ? 1 : 0, time: devices_to_activate_state[device.uri].last_call}, function() {});
            }
            devices_to_activate_state[device.uri].activated = to_activate; 
        })
    });
};

app.get('/api/device/id/:id/', (req, res, next) => {
    let element = devices_to_activate.filter(value => {
        return value.ids.includes(req.params.id);
    });
    if (element.length > 0) {
        let device = element[0];
        normalDecisionReq(device, res);
    } else {
        let err = new Error('Device cannot be found.');
        err.status = 404;
        res.status(404);
        next(err);
    }
});

app.get('/api/device/:name/', (req, res, next) => {
    let element = devices_to_activate.filter(value => {
        return value.uri == req.params.name;
    });
    if (element.length > 0) {
        let device = element[0];
        normalDecisionReq(device, res);
    } else {
        let err = new Error('Device cannot be found.');
        err.status = 404;
        res.status(404);
        next(err);
    }
});

function advancedDecision(device, power, cb) {
    let to_activate_advanced = false;
    let alpha = 128;
    if ((devices_to_activate_state[device.uri].last_call + device.time_limit < (new Date()).getTime() + 1000) && (devices_to_activate_state[device.uri].activated_advanced == true) && (-power < 0)) {
            to_activate_advanced = false;
    } else {
        if ((-power > device.power_limit*device.power_threshold_percentage)) {
            to_activate_advanced = true;
        } else {
            to_activate_advanced = false;
        }
    }
    if (to_activate_advanced) {
        let power_to_consider = -power;
        if (devices_to_activate_state[device.uri].activated_advanced == true) {
            power_to_consider += devices_to_activate_state[device.uri].last_power;
        }
        let result = getAlpha(power_to_consider, device.power_limit);
        alpha = result.alpha;
        devices_to_activate_state[device.uri].last_power = result.percentage*device.power_limit;
    } else {
        devices_to_activate_state[device.uri].last_power = 0;
    }
    devices_to_activate_state[device.uri].activated_advanced = to_activate_advanced; 
    cb(alpha);
}

function advancedDecisionReq(device, res) {
    // make sure that device state exists
    if (!devices_to_activate_state.hasOwnProperty(device.uri)) {
        devices_to_activate_state[device.uri] = { activated: false, activated_advanced: false, last_call: (new Date()).getTime(), last_power: device.power_limit }
    }
    getInformations.req(function (err, power) {
        if (err) return next(err);
        advancedDecision(device, power, function(alpha) {
            res.json({alpha: alpha, time_limit: device.time_limit});
            devices_to_activate_state[device.uri].last_call = (new Date()).getTime();
            if ((alpha < 128) != devices_to_activate_state[device.uri].activated_advanced) {
                db_devices_activation.post({uri: device.uri, activated: (alpha < 128) ? 0 : 2, time: devices_to_activate_state[device.uri].last_call, last_power: devices_to_activate_state[device.uri].last_power}, function() {});
            }
        });
        
    });
};

app.get('/api/device/id/:id/advanced/', (req, res, next) => {
    let element = devices_to_activate.filter(value => {
        return value.ids.includes(req.params.id);
    });
    if (element.length > 0) {
        let device = element[0];
        advancedDecisionReq(device, res);
    } else {
        let err = new Error('Device cannot be found.');
        err.status = 404;
        res.status(404);
        next(err);
    }
});

app.get('/api/device/:name/advanced/', (req, res, next) => {
    let element = devices_to_activate.filter(value => {
        return value.uri == req.params.name;
    });
    if (element.length > 0) {
        let device = element[0];
        advancedDecisionReq(device, res);
    } else {
        let err = new Error('Device cannot be found.');
        err.status = 404;
        res.status(404);
        next(err);
    }
});

app.get('/api/device/:name/debug/', (req, res, next) => {
    let element = devices_to_activate.filter(value => {
        return value.uri == req.params.name;
    });
    if (element.length > 0) {
        let device = element[0];
        // make sure that device state exists
        if (!devices_to_activate_state.hasOwnProperty(device.uri)) {
            devices_to_activate_state[device.uri] = { activated: false, activated_advanced: false, last_call: (new Date()).getTime(), last_power: device.power_limit }
        }
        getInformations.get_moving_average_power(0, function (err, power) {
            if (err) return next(err);
            let last_power_req = power.list[power.list.length-1];
            advancedDecision(device, last_power_req, function(alpha) {
                normalDecision(device, power.average, function (to_activate_normal) {
                    res.json({
                        activated: devices_to_activate_state[device.uri].activated, 
                        toggle: to_activate_normal, 
                        toggle_advanced: (alpha < 128),
                        time_limit: device.time_limit, 
                        power_threshold_percentage: device.power_threshold_percentage, 
                        limit: device.power_limit,
                        last_call: devices_to_activate_state[device.uri].last_call, 
                        power: -last_power_req,
                        last_power: devices_to_activate_state[device.uri].last_power,
                        alpha: alpha,
                        info_type: 'debug'
                    });
                });
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
    db_devices_activation.save(function () {
        res.json(db_devices_activation.getAll());
    });
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

// Write data to influx
setInterval(function () {
    influxLib.daemon(app.get('env') === 'development');
},config.influx_update_delay);

// Get data updated
setInterval(function () {
    getInformations.update(app.get('env') === 'development');
},config.shelly_req_thresold);

