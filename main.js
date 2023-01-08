

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
const db_devices_activation = JSONStore('./devices-activation.json',200);


function get_priority_list(devices_to_activate) {
    const list = devices_to_activate.sort((a, b) => (a.priority > b.priority) ? 1 : -1);
    const simple_list = [];
    list.forEach(function(el) {       
        simple_list.push(el.uri)
    });
    return simple_list;
}

const devices_to_activate_priority_list = get_priority_list(devices_to_activate);

function include_elements(arr1, arr2) {
    return arr1.filter(function(element) {
      return arr2.includes(element);
    });
}

function keep_properties(obj, properties) {
    const newObj = {};
    Object.keys(obj).forEach(key => {
       const newInnerObj = {};
      properties.forEach(prop => {
        if (obj[key].hasOwnProperty(prop)) {
          newInnerObj[prop] = obj[key][prop];
        }
      });
      newObj[key] = newInnerObj;
    });
    return newObj;
}

function print(...args) {
    if (app.get('env') === 'development') {
        console.log(...args);
    }
}

function get_power_from_activated_devices() {
    let sum = 0;
    for (let device in devices_to_activate_state) {
        sum += devices_to_activate_state[device].last_power
    }
    return sum;
}

function pretty_name(name) {
    name = name.replaceAll('-', ' ');
    let words = name.split(' ');
    return words.map((word) => { 
        return word[0].toUpperCase() + word.substring(1); 
    }).join(' ');
}

// Express App
const app = express();

const port = require('env-port')('8889');
app.set('port', port);

const i18n = require('./lib/i18n');
const { cp } = require('fs');

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
            power_activated_device: get_power_from_activated_devices(),
            list_devices: Object.keys(devices_to_activate_state),
            device_states: devices_to_activate_state,
            pretty_name: pretty_name
        });
    });
});

app.get('/force/', function(req, res) {
    res.render('force', {
        list_devices: Object.keys(devices_to_activate_state),
        device_states: devices_to_activate_state,
        pretty_name: pretty_name
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
            power_activated_device: get_power_from_activated_devices(),
            device_states: keep_properties(devices_to_activate_state, ['last_power'])
        });
    });
});

app.get('/api/data-force', function(req, res) {
    res.json({
        device_states: keep_properties(devices_to_activate_state, ['last_power', 'force_mode_percent', 'force_mode'])
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

function normalDecision(device, power) {
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
    return to_activate;
}

function normalDecisionReq(device, res) {
    // make sure that device state exists
    if (!devices_to_activate_state.hasOwnProperty(device.uri)) {
        devices_to_activate_state[device.uri] = {activated: false, activated_advanced: false, last_call: (new Date()).getTime(), last_power: 0, requested_alpha: 128, requested_toggle: false, requested_power: 0, type: 'normal', force_mode: false, force_mode_percent: 0 }
    }
    devices_to_activate_state[device.uri].type = 'normal';
    let to_activate = devices_to_activate_state[device.uri].requested_toggle;
    res.json({toggle: to_activate, time_limit: device.time_limit});
    devices_to_activate_state[device.uri].last_power = devices_to_activate_state[device.uri].requested_power;
    devices_to_activate_state[device.uri].last_call = (new Date()).getTime();
    if (to_activate!= devices_to_activate_state[device.uri].activated) {
        db_devices_activation.post({uri: device.uri, activated: to_activate ? 1 : 0, time: devices_to_activate_state[device.uri].last_call}, function() {});
    }
    devices_to_activate_state[device.uri].activated = to_activate; 
    influxLib.writePower(app.get('env') === 'development', device.uri, to_activate ? device.power_limit : 0);
}

function advancedDecision(device, power) {
    let alpha = 128;
    let percentage = 0;
    let power_to_consider = -power-device.power_limit*device.power_threshold_percentage;
    let result = getAlpha.fromPercent(power_to_consider, device.power_limit);
    if (device.hasOwnProperty('min_alpha')) {
        if (result.alpha < device.min_alpha) {
            result = getAlpha.fromMinAlpha(device.min_alpha);
        }
    }
    devices_to_activate_state[device.uri].requested_power = result.percentage*device.power_limit;
    return result
}

function advancedDecisionReq(device, res) {
    // make sure that device state exists
    if (!devices_to_activate_state.hasOwnProperty(device.uri)) {
        devices_to_activate_state[device.uri] = { activated: false, activated_advanced: false, last_call: (new Date()).getTime(), last_power: 0, requested_alpha: 128, requested_toggle: false, requested_power: 0, requested_power: 0, type: 'advanced', force_mode: false, force_mode_percent: 0 }
    }
    devices_to_activate_state[device.uri].type = 'advanced';
    let alpha = devices_to_activate_state[device.uri].requested_alpha;
    res.json({alpha: alpha, time_limit: device.time_limit});
    devices_to_activate_state[device.uri].last_call = (new Date()).getTime();
    devices_to_activate_state[device.uri].last_power = devices_to_activate_state[device.uri].requested_power;
    if ((alpha < 128) != devices_to_activate_state[device.uri].activated_advanced) {
        db_devices_activation.post({uri: device.uri, activated: (alpha < 128) ? 2 : 0, time: devices_to_activate_state[device.uri].last_call, last_power: devices_to_activate_state[device.uri].last_power}, function() {});
    }
    if (alpha != devices_to_activate_state[device.uri].last_alpha) {
        influxLib.writePower(app.get('env') === 'development', device.uri, devices_to_activate_state[device.uri].last_power);
    }            
    devices_to_activate_state[device.uri].last_alpha = alpha; 
    devices_to_activate_state[device.uri].activated_advanced = alpha < 128; 
};

app.get('/api/device/id/:id/', (req, res, next) => {
    let element = devices_to_activate.filter(value => {
        return value.ids.includes(req.params.id);
    });
    if (element.length > 0) {
        let device = element[0];
        normalDecisionReq(device, res);
    } else {
        console.error('Device cannot be found.');
        res.statusCode = 404;
        res.json({ toggle: false, time_limit: 5000 });
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
        console.error('Device cannot be found.');
        res.statusCode = 404;
        res.json({ toggle: false, time_limit: 5000 });
    }
});

app.get('/api/device/:name/force/:pass/disable', (req, res, next) => {
    let element = devices_to_activate.filter(value => {
        return value.uri == req.params.name;
    });
    if (element.length > 0) {
        let device = element[0];
        if (config.force_mode_pass == req.params.pass) {
            devices_to_activate_state[device.uri].force_mode = false;
            devices_to_activate_state[device.uri].force_mode_percent = 0;
            res.json({ force_mode: devices_to_activate_state[device.uri].force_mode, percent: devices_to_activate_state[device.uri].force_mode_percent });
        } else {
            let err = new Error('Forbidden.');
            err.status = 403;
            res.status(403);
            next(err); 
        }
    } else {
        let err = new Error('Device cannot be found.');
        err.status = 404;
        res.status(404);
        next(err);
    }
});

app.get('/api/device/:name/force/:pass/:percent', (req, res, next) => {
    let element = devices_to_activate.filter(value => {
        return value.uri == req.params.name;
    });
    if (element.length > 0) {
        let device = element[0];
        if (config.force_mode_pass == req.params.pass) {
            let tmp = Number(req.params.percent);
            if (isNaN(tmp)) {
                devices_to_activate_state[device.uri].force_mode = false;
                devices_to_activate_state[device.uri].force_mode_percent = 0;
            } else {
                devices_to_activate_state[device.uri].force_mode = true;
                if (tmp > 1) {
                    tmp = 1;
                }
                devices_to_activate_state[device.uri].force_mode_percent = tmp;
            }
            res.json({ force_mode: devices_to_activate_state[device.uri].force_mode, percent: devices_to_activate_state[device.uri].force_mode_percent });
        } else {
            let err = new Error('Forbidden.');
            err.status = 403;
            res.status(403);
            next(err); 
        }
    } else {
        let err = new Error('Device cannot be found.');
        err.status = 404;
        res.status(404);
        next(err);
    }
});

app.get('/api/device/id/:id/advanced/', (req, res, next) => {
    let element = devices_to_activate.filter(value => {
        return value.ids.includes(req.params.id);
    });
    if (element.length > 0) {
        let device = element[0];
        advancedDecisionReq(device, res);
    } else {
        console.error('Device cannot be found.');
        res.statusCode = 404;
        res.json({ alpha: 128, time_limit: 5000 });
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
        console.error('Device cannot be found.');
        res.statusCode = 404;
        res.json({ alpha: 128, time_limit: 5000 });
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
            let err = new Error('Device not connected yet.');
            err.status = 3;
            res.status(503);
            return next(err);
        }
        getInformations.req(function (err, save) {
            if (err) return next(err);
            let power = save.emeters[0].power;
            res.json({
                activated: devices_to_activate_state[device.uri].activated, 
                toggle: devices_to_activate_state[device.uri].requested_toggle, 
                toggle_advanced: devices_to_activate_state[device.uri].activated_advanced,
                time_limit: device.time_limit, 
                power_threshold_percentage: device.power_threshold_percentage, 
                limit: device.power_limit,
                last_call: devices_to_activate_state[device.uri].last_call, 
                power: -power,
                last_power: devices_to_activate_state[device.uri].last_power,
                requested_power: devices_to_activate_state[device.uri].requested_power,
                last_alpha: devices_to_activate_state[device.uri].last_alpha,
                requested_alpha: devices_to_activate_state[device.uri].requested_alpha,
                type: devices_to_activate_state[device.uri].type,
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
    if (!devices_to_activate_state.hasOwnProperty(req.params.device_name)) {
        let err = new Error('Device not connected yet.');
        err.status = 503;
        res.status(503);
        return next(err);
    }
    res.render('device-info', {
        timezone: config.timezone,
        device_name: req.params.device_name
    });
});

app.get('/device/list/graph/:period', (req, res, next) => {
    res.render('device-list-graph-power', {
        timezone: config.timezone,
        list_devices: Object.keys(devices_to_activate_state),
        period: req.params.period
    });
});


app.get('/device/:device_name/graph/:period', (req, res, next) => {
    res.render('device-graph-power', {
        timezone: config.timezone,
        device_name: req.params.device_name,
        period: req.params.period
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
    getInformations.req(function (err, save) {
            if (err) {
                console.error("Error while requesting data.");
            }
            let power = save.emeters[0].power - get_power_from_activated_devices();
            //power = -800; // for test
            if (power < 0) {
                influxLib.writePowerRaw(app.get('env') === 'development', save);
            }
            //print("Power available: " + power);
            const devices_to_consider = include_elements(devices_to_activate_priority_list,Object.keys(devices_to_activate_state));
            //print("Devices to consider: ",devices_to_consider);
            for (let i = 0; i < devices_to_consider.length; i++) {
                let device = devices_to_activate.filter(value => {
                    return value.uri == devices_to_consider[i];
                })[0];
                if (devices_to_activate_state[device.uri].type == 'normal') {
                    let to_activate = normalDecision(device, power);
                    if (devices_to_activate_state[device.uri].force_mode) {
                        to_activate = (devices_to_activate_state[device.uri].force_mode_percent >= 1);
                    }
                    devices_to_activate_state[device.uri].requested_toggle = to_activate;
                    devices_to_activate_state[device.uri].requested_power = (to_activate) ? device.power_limit : 0; 
                    
                    //print("[" + device.uri + "] activated = " + to_activate + ", power = " + devices_to_activate_state[device.uri].requested_power + " W (100%)")
                }
                if (devices_to_activate_state[device.uri].type == 'advanced') {
                    let { alpha, percentage } = advancedDecision(device, power);
                    devices_to_activate_state[device.uri].requested_alpha = alpha;
                    devices_to_activate_state[device.uri].requested_power = percentage*device.power_limit;
                    if (devices_to_activate_state[device.uri].force_mode) {
                        let { alpha, percentage } = advancedDecision(device, -devices_to_activate_state[device.uri].force_mode_percent*device.power_limit);
                        devices_to_activate_state[device.uri].requested_alpha = alpha;
                        devices_to_activate_state[device.uri].requested_power = percentage*device.power_limit;
                    }
                    //print("[" + device.uri + "] alpha = " + alpha + ", power = " + devices_to_activate_state[device.uri].requested_power + " W (" + percentage*100 + "%)")
                }
                power += devices_to_activate_state[device.uri].requested_power;
                //print("Power to consider after '" + device.uri + "' : " + power);
            }
    });
},config.shelly_req_thresold);

