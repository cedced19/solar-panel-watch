// Create or complete config.json from config-default.json before any module reads it.
require('./lib/config-file.js').ensureConfig();

const fs = require('fs');
const express = require('express');
const favicon = require('express-favicon');
const path = require('path');
const logger = require('morgan');
const compress = require('compression');
const minifyTemplate = require('express-beautify').minify;
const requestIp = require('request-ip');

const getPowerData = require('./lib/get-power-data.js');
const getAlpha = require('./lib/get-alpha.js');
const influxLib = require('./lib/influx-lib.js');
const getDeviceEnergy = require('./lib/compute-energy-device.js');
const computeEnergy = require('./lib/compute-energy.js');
const computeConsumptionPower = require('./lib/compute-consumption-power.js');
const { validatePeriod, validateGroup, isValidPeriod } = require('./lib/validate-params.js');
const batteryLogic = require('./lib/battery-logic.js');
const { createAuth, readOptions } = require('./lib/auth.js');
const { createConfigPanel } = require('./lib/config-panel.js');
const { createEnergyDayStore } = require('./lib/energy-day-store.js');
const { createEnergyDays, isValidDay } = require('./lib/energy-days.js');


const JSONStore = require('json-store-list');

const config = require('./config.json');

const batterySettings = batteryLogic.readSettings(config);

// Login (emails in config.auth.mails) guarding the configuration panel and the force page.
const auth = createAuth(readOptions(config));

// One energy summary per local day; see lib/energy-days.js.
const energyDays = createEnergyDays({
    store: createEnergyDayStore(path.join(__dirname, 'energy-days.sqlite')),
    influx: influxLib,
    computeEnergy
});

const devices_to_activate = require('./devices-to-activate.json');
const devices_to_activate_state = {};
const db_devices_activation = JSONStore('./devices-activation.json',200);

// Keep devices inactive until the configured house meter supplies valid power.
let powerDataAvailable = false;
let batteryData = null;
let batteryReceivedAt = 0;
const batteryRequestTimeout = Number.isFinite(config.zendure_request_timeout) && config.zendure_request_timeout > 0 ? config.zendure_request_timeout : 3000;

// Forcing is decided first: a forced device runs at its chosen level whatever the battery does.
// For the other devices the battery is served first; see lib/battery-logic.js for the rules.
// This check only uses the battery reading, independently of the devices.
function getDeviceChargingStatus() {
    const readingAge = Date.now() - batteryReceivedAt;
    const batteryFresh = readingAge >= 0 && readingAge <= getPowerData.batteryRequestThreshold + batteryRequestTimeout;
    return batteryLogic.getDeviceActivation({
        battery: batteryFresh ? batteryData : null,
        powerAvailable: powerDataAvailable
    }, batterySettings);
}

function disableDeviceCharging(state) {
    state.requested_toggle = false;
    state.requested_alpha = 128;
    state.requested_power = 0;
}

// The battery decision comes after forcing, so it never turns off a forced device.
function disableUnforcedDevice(state) {
    if (!state.force_mode) disableDeviceCharging(state);
}

function disableRequestedDevices() {
    Object.values(devices_to_activate_state).forEach(disableUnforcedDevice);
}

function requestBatteryData(cb) {
    getPowerData.reqBattery(function (err, data) {
        batteryData = err ? null : data;
        // Cached responses retain the original reading time; they must not extend its validity.
        batteryReceivedAt = !err && data && Number.isFinite(data.time) ? Math.min(Date.now(), data.time * 1000) : Date.now();
        if (!getDeviceChargingStatus().enabled) disableRequestedDevices();
        cb(err, data);
    });
}

function requestPowerData(cb) {
    getPowerData.req(function (err, data) {
        powerDataAvailable = !err;
        if (!getDeviceChargingStatus().enabled) disableRequestedDevices();
        cb(err, data);
    });
}

function powerUnavailableMessage() {
    return getPowerData.getHousePowerSource() === 'zendure'
        ? 'Zendure house power data is unavailable.'
        : 'Shelly data is unavailable.';
}

const reload_files_dir = './reload_files/'; // reload files

if (!fs.existsSync(reload_files_dir)){
    fs.mkdirSync(reload_files_dir);
}

function save_force_mode(uri, obj) {
    let file_path = reload_files_dir + uri + '.json';
    let json_data = JSON.stringify(obj, null, 2);

    fs.writeFile(file_path, json_data, (err) => {
      if (err) {
        console.error('File ' + uri + '.json could not be written.');
        console.error(err);
      }
    });
}

function load_force_mode(uri) {
    let file_path = reload_files_dir + uri + '.json';
    if (fs.existsSync(file_path)){
        try {
            const json_data = fs.readFileSync(file_path, 'utf8');
            const data = JSON.parse(json_data);
            
            return data;
        } catch (error) {
            console.error(`Error reading JSON file: ${error.message}`);
            return {force_mode: false, percent: 0};
        }
    } else {
        return {force_mode: false, percent: 0};
    }
}



function init_device(device, type, req) {
    if (!devices_to_activate_state.hasOwnProperty(device.uri)) {
        force_mode_values_reload = load_force_mode(device.uri); // get the previous saved forced values
        devices_to_activate_state[device.uri] = {
            activated: false, 
            activated_advanced: false, 
            last_call: (new Date()).getTime(),
            last_power: 0, 
            requested_alpha: 128, 
            requested_toggle: false,
            requested_power: 0, 
            type: type, 
            force_mode: force_mode_values_reload.force_mode, 
            force_mode_percent: force_mode_values_reload.percent, 
            max_energy_reached: false,
            target_reached_over_period: false,
            last_control_var: NaN,
            ip: requestIp.getClientIp(req)
        }
        if (device.hasOwnProperty('max_energy_time_range') && device.hasOwnProperty('max_energy_val')) {
            getDeviceEnergy(device.max_energy_time_range, device.uri, (err, value) => {
                if (err) {
                    return console.error('Cannot determine energy.');
                }
                devices_to_activate_state[device.uri].max_energy_reached = (value >= device.max_energy_val);
            });
        }
        if (device.hasOwnProperty('max_control_var_val') && device.hasOwnProperty('period_after_target')) {
            influxLib.requestVarOverPeriod(device.period_after_target, device.uri).then(function (data) {
                devices_to_activate_state[device.uri].target_reached_over_period = (influxLib.getMaxValueOverData(data) >= device.max_control_var_val);
            }, function (error) {
                console.log(error);
                return console.error('Cannot determine when if target has been reached over period.');
            });
        }
        if (device.hasOwnProperty('max_control_var_val')) {
            influxLib.requestLastVar(device.uri).then(function (data) {
                if (data.length) {
                    devices_to_activate_state[device.uri].last_control_var = data[0]._value;
                }
            });
        }
    }
}

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

function check_environment_for_power_consumption(device) {
    if (devices_to_activate_state[device.uri].max_energy_reached) { // Check using energy
        return false;
    }
    if (devices_to_activate_state[device.uri].target_reached_over_period) { // Check if target has been reached over period
        return false;
    }
    if (device.hasOwnProperty('max_control_var_val') && !isNaN(devices_to_activate_state[device.uri].last_control_var)) {
        if (devices_to_activate_state[device.uri].last_control_var > device.max_control_var_val) { // Check using control variable
            if (device.hasOwnProperty('period_after_target')) {
                // Target has been reached over period
                devices_to_activate_state[device.uri].target_reached_over_period = true;
            }
            return false;
        }
    }
    return true;
}

function print(...args) {
    if (app.get('env') === 'development') {
        console.log(...args);
    }
}

function is_device_connected(time_limit, last_call, coeff) {
    // Calculate the maximum allowed time since the last call
    let max_allowed_time = coeff * time_limit;
    // Now
    let now = (new Date()).getTime();
    // Check if the device is still connected
    if (now - last_call < max_allowed_time) {
      return true;
    } else {
      return false;
    }
}

function get_power_from_activated_devices() {
    const devices_to_consider = include_elements(devices_to_activate_priority_list,Object.keys(devices_to_activate_state));
    let sum = 0;
    for (let i = 0; i < devices_to_consider.length; i++) {
        let device = devices_to_activate.filter(value => {
            return value.uri == devices_to_consider[i];
        })[0];
        if ((devices_to_activate_state[device.uri].force_mode == false) && (is_device_connected(device.time_limit, devices_to_activate_state[device.uri].last_call, 2))) { 
            // Prevent from considering forced power as available power
            // Short disconnections are to be considered
            sum += devices_to_activate_state[device.uri].last_power; 
        }
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

app.use(express.urlencoded({
    extended: true
}));

app.use('/assets/', express.static('assets'));

app.get('/', function(req, res) {
    const batteryResult = new Promise((resolve) => {
        requestBatteryData((err, battery) => resolve(err ? null : battery));
    });
    requestPowerData(function (err, data) {
        const recovery = getPowerData.getHouseRecoveryState();
        const source = getPowerData.getHousePowerSource();
        if (err) return res.status(503).render('index', {
            error: true, recovery, power_source: source
        });
        batteryResult.then(function (battery) {
            res.render('index', {
                error: false,
                power_source: source,
                power1: data.emeters[0].power,
                power2: data.emeters[1].power,
                power_activated_device: get_power_from_activated_devices(),
                list_devices: Object.keys(devices_to_activate_state),
                device_states: devices_to_activate_state,
                pretty_name: pretty_name,
                battery,
                device_charging: getDeviceChargingStatus(),
                zendure_battery_req_threshold: getPowerData.batteryRequestThreshold,
                recovered_shelly_ip: getPowerData.getShellyRecoveryState().recoveredIp,
                recovered_zendure_ip: source === 'zendure' ? recovery.recoveredIp : null
            });
        });
    });
});

// The page is public like /config/; device states and forcing go through APIs that need a login.
app.get('/force/', function(req, res) {
    res.render('force', {
        list_devices: Object.keys(devices_to_activate_state),
        pretty_name: pretty_name,
        otp_ttl_minutes: auth.otpTtlMinutes(),
        sender_configured: auth.senderConfigured()
    });
});

app.get('/battery/settings/', function(req, res) {
    res.render('battery-settings');
});

app.get('/nomenclature/', function(req, res) {
    if (req.query.lang === 'en' || req.query.lang === 'fr') {
        req.setLocale(req.query.lang);
    }
    const locale = req.getLocale();
    res.set('Content-Language', locale);
    res.vary('Accept-Language');
    res.render('nomenclature', {locale});
});

app.get('/graph/power/:period', validatePeriod, function(req, res) {
    res.render('graph-power', {
        period: req.params.period,
        timezone: config.timezone
    });
});

app.get('/graph/battery/:period', validatePeriod, function(req, res) {
    res.render('graph-battery', {
        period: req.params.period,
        timezone: config.timezone,
        battery_poll_interval: getPowerData.batteryRequestThreshold
    });
});

app.get('/graph/power/:period/group-by/:group/', validatePeriod, validateGroup, function(req, res) {
    res.render('graph-power-group', {
        period: req.params.period,
        group: req.params.group,
        timezone: config.timezone
    });
});

app.get('/graph/power/:period/activation-hist-plot/', validatePeriod, function(req, res) {
    res.render('graph-power-activation-hist', {
        period: req.params.period,
        timezone: config.timezone
    });
});

app.get('/energy/current-day', function(req, res) {
    res.render('energy', {
        day: energyDays.today(),
        timezone: config.timezone
    });
});

// Former period summaries now live in the energy graph.
app.get('/energy/:period', function(req, res, next) {
    const match = /^(\d{1,4})d$/.exec(req.params.period);
    if (!match) return next();
    res.redirect('/energy-graph/#duration=' + parseInt(match[1], 10));
});

app.get('/energy-graph/', function(req, res) {
    res.render('energy-graph', {
        timezone: config.timezone,
        config: {
            latitude: config.latitude || '',
            longitude: config.longitude || '',
            timezone: config.timezone || 'auto'
        }
    });
});

app.get('/energy-calendar/', function(req, res) {
    res.render('energy-calendar', {
        timezone: config.timezone
    });
});

app.get('/activation-hist/', function(req, res) {
    res.render('activation-hist', {
        timezone: config.timezone
    });
});

app.get('/api/data', function(req, res) {
    requestPowerData(function (err, data) {
        if (err) {
            return res.status(503).json({error: powerUnavailableMessage(), device_charging: getDeviceChargingStatus()});
        }
        res.json({
            power1: data.emeters[0].power,
            power2: data.emeters[1].power,
            house_power_source: getPowerData.getHousePowerSource(),
            device_charging: getDeviceChargingStatus(),
            power_activated_device: get_power_from_activated_devices(),
            device_states: keep_properties(devices_to_activate_state, ['last_power'])
        });
    });
});

app.get('/api/battery', function(req, res) {
    requestBatteryData(function (err, battery) {
        if (err) {
            return res.status(503).json({error: 'Zendure battery data is unavailable.', device_charging: getDeviceChargingStatus()});
        }
        res.json({...battery, device_charging: getDeviceChargingStatus()});
    });
});

// Read on demand only: the settings are not polled in the background.
app.get('/api/battery/settings', function(req, res) {
    getPowerData.reqBatterySettings(function (err, settings) {
        if (err) {
            return res.status(503).json({error: 'Zendure battery settings are unavailable.'});
        }
        res.json(settings);
    });
});

app.get('/api/data/battery/:period', validatePeriod, (req, res, next) => {
    influxLib.requestBatteryLevelOverPeriod(req.params.period).then(function (data) {
        if (req.query.format === 'csv') {
            res.set('Content-Type', 'text/csv');
            return res.send(influxLib.pointsToCSV(data, [
                '_time', '_value', 'outputHomePower', 'gridInputPower', 'outputPackPower', 'packInputPower'
            ]));
        }
        res.json(data);
    }, function (error) {
        error.status = 500;
        next(error);
    });
}, function (error, req, res, next) {
    res.status(error.status || 500).json({error: error.message});
});

app.get('/api/data-force', auth.requireLogin, function(req, res) {
    res.json({
        device_states: keep_properties(devices_to_activate_state, ['last_power', 'force_mode_percent', 'force_mode'])
    });
});


app.get('/api/data/power/:tag/:period', validatePeriod, (req, res, next) => {
    // Response scale (most specific wins):
    //   ?raw=true          -> raw interval (no aggregation)
    //   ?every=<duration>  -> explicit aggregation window (e.g. 5m, 30m, 1h)
    //   otherwise          -> automatic window by period, or none if
    //                         config.graph_downsampling = "none"
    let promise;
    if (req.query.raw === 'true' || config.graph_downsampling === 'none') {
        promise = influxLib.requestPowerOverPeriod(req.params.period, req.params.tag);
    } else if (req.query.every && isValidPeriod(req.query.every)) {
        promise = influxLib.requestPowerOverPeriodGraph(req.params.period, req.params.tag, req.query.every);
    } else {
        promise = influxLib.requestPowerOverPeriodGraph(req.params.period, req.params.tag);
    }

    promise.then(function (data) {
        if (req.query.format === 'csv') {
            res.set('Content-Type', 'text/csv');
            return res.send(influxLib.pointsToCSV(data));
        }
        res.json(data);
    }, function (error) {
        error.status = 500;
        res.status(500);
        next(error);
    });
});

app.get('/api/data/var/:tag/:period', validatePeriod, (req, res, next) => {
    influxLib.requestVarOverPeriod(req.params.period, req.params.tag).then(function (data) {
        if (req.query.format === 'csv') {
            res.set('Content-Type', 'text/csv');
            return res.send(influxLib.pointsToCSV(data));
        }
        res.json(data);
    }, function (error) {
        error.status = 500;
        res.status(500);
        next(error);
    });
});

app.get('/api/data/consumption/:period', validatePeriod, (req, res) => {
    const raw = req.query.raw === 'true' || config.graph_downsampling === 'none';
    const every = raw ? null :
        (isValidPeriod(req.query.every) ? req.query.every : influxLib.getAggregateWindow(req.params.period));
    influxLib.requestConsumptionOverPeriod(req.params.period, every).then(data => {
        res.json(computeConsumptionPower(data, {
            aggregated: Boolean(every),
            powerMaxAgeMs: (config.influx_update_delay || 15000) * 2,
            batteryMaxAgeMs: getPowerData.batteryRequestThreshold + batteryRequestTimeout
        }));
    }, error => {
        res.status(500).json({error: error.message});
    });
});

function energyDayError(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

// Validates a local day (YYYY-MM-DD) that is not after today.
function validateDay(req, res, next) {
    if (!isValidDay(req.params.date)) {
        return next(energyDayError('Invalid "date" parameter. Expected a date like "2026-08-24".'));
    }
    if (req.params.date > energyDays.today()) {
        return next(energyDayError('Invalid "date" parameter. Days after today have no energy data.'));
    }
    next();
}

function sendEnergyDay(promise, res, next) {
    promise.then(function (row) {
        res.json(row);
    }, function (error) {
        error.status = 500;
        res.status(500);
        next(error);
    });
}

// Stored summaries of an inclusive range of local days, plus the days that
// still need a calculation. Without bounds: first stored day to today.
app.get('/api/data/energy/days', (req, res, next) => {
    const today = energyDays.today();
    for (const bound of ['start', 'end']) {
        if (req.query[bound] !== undefined && !isValidDay(req.query[bound])) {
            return next(energyDayError('Invalid "' + bound + '" parameter. Expected a date like "2026-08-24".'));
        }
    }
    const days = energyDays.store.range(req.query.start, req.query.end);
    const start = req.query.start || (days.length ? days[0].day : today);
    const end = req.query.end || today;
    res.json({days, stale: start <= end ? energyDays.staleDays(start, end) : []});
});

// Energy of one local day: the stored summary, computed when missing or partial.
app.get('/api/data/energy/day/:date', validateDay, (req, res, next) => {
    sendEnergyDay(energyDays.getDay(req.params.date), res, next);
});

app.post('/api/data/energy/day/:date/recompute', validateDay, (req, res, next) => {
    sendEnergyDay(energyDays.getDay(req.params.date, {force: true}), res, next);
});

// Stored days with their state, for the calendar colours.
app.get('/api/data/energy-calendar/', (req, res) => {
    res.json(energyDays.store.days());
});

app.get('/api/data/power/:tag/:period/group-by/:group/', validatePeriod, validateGroup, (req, res, next) => {
    influxLib.requestPowerOverPeriodGroupBy(req.params.period, req.params.tag, req.params.group).then(function (data) {
        if (req.query.format === 'csv') {
            res.set('Content-Type', 'text/csv');
            return res.send(influxLib.pointsToCSV(data));
        }
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

function normalDecisionReq(device, req, res) {
    if (!powerDataAvailable) {
        return res.json({toggle: false, time_limit: device.time_limit});
    }
    // make sure that device state exists
    init_device(device, 'normal', req);
    if (!getDeviceChargingStatus().enabled) disableUnforcedDevice(devices_to_activate_state[device.uri]);
    let to_activate = devices_to_activate_state[device.uri].requested_toggle;
    res.json({toggle: to_activate, time_limit: device.time_limit});
    devices_to_activate_state[device.uri].last_power = to_activate ? devices_to_activate_state[device.uri].requested_power : 0;
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

function advancedDecisionReq(device, req, res) {
    if (!powerDataAvailable) {
        return res.json({alpha: 128, time_limit: device.time_limit});
    }
    // make sure that device state exists
    init_device(device, 'advanced', req);
    if (!getDeviceChargingStatus().enabled) disableUnforcedDevice(devices_to_activate_state[device.uri]);
    let alpha = devices_to_activate_state[device.uri].requested_alpha;
    res.json({alpha: alpha, time_limit: device.time_limit});
    devices_to_activate_state[device.uri].last_call = (new Date()).getTime();
    devices_to_activate_state[device.uri].last_power = alpha < 128 ? devices_to_activate_state[device.uri].requested_power : 0;
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
        normalDecisionReq(device, req, res);
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
        normalDecisionReq(device, req, res);
    } else {
        console.error('Device cannot be found.');
        res.statusCode = 404;
        res.json({ toggle: false, time_limit: 5000 });
    }
});

// Forcing needs a login. Only devices that already called the app have a
// state to force: they are the ones listed on /force/.
function requireConnectedDevice(req, res, next) {
    if (!devices_to_activate_state.hasOwnProperty(req.params.name)) {
        return res.status(404).json({ ok: false, error: 'unknown-device' });
    }
    next();
}

function set_force_mode(uri, force_mode, percent) {
    devices_to_activate_state[uri].force_mode = force_mode;
    devices_to_activate_state[uri].force_mode_percent = percent;
    let obj = { force_mode: force_mode, percent: percent };
    save_force_mode(uri, obj);
    return obj;
}

// Body {"percent": 0 to 1}: the device runs at that share of its power, 0 keeps it off.
app.put('/api/device/:name/force', auth.requireLogin, requireConnectedDevice, express.json(), (req, res) => {
    const percent = req.body && req.body.percent;
    if (typeof percent !== 'number' || !(percent >= 0 && percent <= 1)) {
        return res.status(400).json({ ok: false, error: 'invalid-percent' });
    }
    console.log(`[force] ${req.params.name} forced to ${percent} by ${req.authEmail}`);
    res.json(set_force_mode(req.params.name, true, percent));
});

// Gives the device back to the automatic logic.
app.delete('/api/device/:name/force', auth.requireLogin, requireConnectedDevice, (req, res) => {
    console.log(`[force] ${req.params.name} released by ${req.authEmail}`);
    res.json(set_force_mode(req.params.name, false, 0));
});

app.get('/api/device/id/:id/advanced/', (req, res, next) => {
    let element = devices_to_activate.filter(value => {
        return value.ids.includes(req.params.id);
    });
    if (element.length > 0) {
        let device = element[0];
        advancedDecisionReq(device, req, res);
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
        advancedDecisionReq(device, req, res);
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
        requestPowerData(function (err, save) {
            if (err) {
                return res.status(503).json({error: powerUnavailableMessage()});
            }
            let power = save.emeters[0].power;
            res.json({
                ids: device.ids, 
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
                target_reached_over_period : devices_to_activate_state[device.uri].target_reached_over_period,
                period_after_target : (device.hasOwnProperty('period_after_target')) ? device.period_after_target: 'N/A',
                type: devices_to_activate_state[device.uri].type,
                info_type: 'debug',
                force_mode: devices_to_activate_state[device.uri].force_mode,
                ip: devices_to_activate_state[device.uri].ip,
                force_mode_percent: devices_to_activate_state[device.uri].force_mode_percent,
                max_energy_reached: devices_to_activate_state[device.uri].max_energy_reached,
                max_energy_val: (device.hasOwnProperty('max_energy_val')) ? device.max_energy_val: 'N/A',
                max_energy_time_range: (device.hasOwnProperty('max_energy_time_range')) ? device.max_energy_time_range: 'N/A',
                connected: is_device_connected(device.time_limit, devices_to_activate_state[device.uri].last_call, 20),
                var_label : (device.hasOwnProperty('var_label')) ? device.var_label: 'N/A',
                max_control_var_val : (device.hasOwnProperty('max_control_var_val')) ? device.max_control_var_val: 'N/A',
                last_control_var : (isNaN(devices_to_activate_state[device.uri].last_control_var)) ? 'N/A': devices_to_activate_state[device.uri].last_control_var
            });
        });
    } else {
        let err = new Error('Device cannot be found.');
        err.status = 404;
        res.status(404);
        next(err);
    }
});

app.get('/api/device/:name/debug/energy/:period/', validatePeriod, (req, res, next) => {
    let element = devices_to_activate.filter(value => {
        return value.uri == req.params.name;
    });
    if (element.length > 0) {
        let device = element[0];
        // make sure that device state exists
        if (!devices_to_activate_state.hasOwnProperty(device.uri)) {
            let err = new Error('Device not connected yet.');
            err.status = 503;
            res.status(503);
            return next(err);
        }
        getDeviceEnergy(req.params.period, req.params.name, (err, value) => {
            if (err) {
                let err = new Error('Cannot compute data.');
                err.status = 500;
                res.status(500);
                return next(err);
            }
            res.json({
                value: value,
                unit: 'Wh'
            });
        });
    } else {
        let err = new Error('Device cannot be found.');
        err.status = 404;
        res.status(404);
        next(err);
    }
});

// Compare both energy computation methods (InfluxDB integral vs client stream)
// for the same device and period, to validate that they agree.
app.get('/api/device/:name/debug/energy-compare/:period/', validatePeriod, (req, res, next) => {
    const integral = getDeviceEnergy.computeDeviceEnergyIntegral(req.params.period, req.params.name);
    const stream = new Promise(function (resolve, reject) {
        getDeviceEnergy.computeDeviceEnergyStream(req.params.period, req.params.name, function (err, value) {
            if (err) return reject(err);
            resolve(value);
        });
    });
    Promise.all([integral, stream]).then(function (values) {
        res.json({ integral: values[0], stream: values[1], unit: 'Wh' });
    }, function (error) {
        error.status = 500;
        res.status(500);
        next(error);
    });
});


app.post('/api/device/id/:id/control-variable/', (req, res, next) => {
    let element = devices_to_activate.filter(value => {
        return value.ids.includes(req.params.id);
    });
    if (element.length > 0) {
        res.json({ status: 'ok' });
        let device = element[0];
        let value = Number(req.body.var);
        devices_to_activate_state[device.uri].last_control_var = value;
        try {
            if (!isNaN(value)) {
                influxLib.writeVar(app.get('env') === 'development', device.uri, value);
            } else {
                console.error('Value is NaN');
                console.log(req.body);
            }
        } catch (e) {
            console.error(e);
        }
    } else {
        console.error('Device cannot be found.');
        res.statusCode = 404;
        res.json({ status: 'error' });
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

app.get('/device/list/graph/:period', validatePeriod, (req, res, next) => {
    res.render('device-list-graph-power', {
        timezone: config.timezone,
        list_devices: Object.keys(devices_to_activate_state),
        period: req.params.period
    });
});

app.get('/device/:device_name/control-variable/graph/:period', validatePeriod, (req, res, next) => {
    let element = devices_to_activate.filter(value => {
        return value.uri == req.params.device_name;
    });
    if (element.length > 0) {
        let device = element[0];
        res.render('device-graph-var', {
            timezone: config.timezone,
            device_name: req.params.device_name,
            period: req.params.period,
            label: device.var_label
        });
    } else {
        let err = new Error('Device cannot be found.');
        err.status = 404;
        res.status(404);
        next(err);
    }
});

app.get('/device/:device_name/control-variable-power/graph/:period', validatePeriod, (req, res, next) => {
    let element = devices_to_activate.filter(value => {
        return value.uri == req.params.device_name;
    });
    if (element.length > 0) {
        let device = element[0];
        res.render('device-graph-var-power', {
            timezone: config.timezone,
            device_name: req.params.device_name,
            period: req.params.period,
            label: device.var_label
        });
    } else {
        let err = new Error('Device cannot be found.');
        err.status = 404;
        res.status(404);
        next(err);
    }
});

app.get('/device/:device_name/graph/:period', validatePeriod, (req, res, next) => {
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

// Configuration panel and the login routes shared with the force page.
app.use(createConfigPanel({
    configPath: path.join(__dirname, 'config.json'),
    runningConfig: config,
    auth: auth
}));

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


function startBackgroundTasks() {

// Battery charge gates device decisions while retaining its own slower cadence.
// Save SOC and all available power fields from the same battery report,
// independently of house power availability and device activation.
function pollBattery() {
    requestBatteryData(function (err, battery) {
        if (!err && getDeviceChargingStatus().socPercent !== null) {
            influxLib.writeBatteryLevel(app.get('env') === 'development', battery);
        }
    });
}
pollBattery();
setInterval(pollBattery, getPowerData.batteryRequestThreshold);
// Write data to influx
setInterval(function () {
    influxLib.daemon(app.get('env') === 'development', config.save_network_data);
},config.influx_update_delay);

// Check if energy threshold is not reached (in case of water boiler)
setInterval(function () {
    const devices_to_consider = include_elements(devices_to_activate_priority_list,Object.keys(devices_to_activate_state));
    for (let i = 0; i < devices_to_consider.length; i++) {
        let device = devices_to_activate.filter(value => {
            return value.uri == devices_to_consider[i];
        })[0];
        if (device.hasOwnProperty('max_energy_time_range') && device.hasOwnProperty('max_energy_val')) {
            getDeviceEnergy(device.max_energy_time_range, device.uri, (err, value) => {
                if (err) {
                    console.log(err);
                    return console.error('Cannot determine energy.');
                }
                devices_to_activate_state[device.uri].max_energy_reached = (value >= device.max_energy_val);
            });
        }
        // Might require some delay between tasks if too much devices
    }
},config.energy_req_threshold);

// Check if max variable has been reached once over the last check period (in case of water boiler)
setInterval(function () {
    const devices_to_consider = include_elements(devices_to_activate_priority_list,Object.keys(devices_to_activate_state));
    for (let i = 0; i < devices_to_consider.length; i++) {
        let device = devices_to_activate.filter(value => {
            return value.uri == devices_to_consider[i];
        })[0];
        if (device.hasOwnProperty('max_control_var_val') && device.hasOwnProperty('period_after_target')) {
            influxLib.requestVarOverPeriod(device.period_after_target, device.uri).then(function (data) {
                devices_to_activate_state[device.uri].target_reached_over_period = (influxLib.getMaxValueOverData(data) >= device.max_control_var_val);
            }, function (error) {
                console.log(error);
                return console.error('Cannot determine when if target has been reached over period.');
            });
        }
        // Might require some delay between tasks if too much devices
    }
},config.target_req_threshold);

// Get data updated
setInterval(function () {
    requestPowerData(function (err, save) {
            if (err) {
                return console.error("Error while requesting data.");
            }
            let power = save.emeters[0].power - get_power_from_activated_devices();
            //power = -800; // for test
            if (power < 0) {
                if (config.save_network_data) {
                    // log also data from network
                    influxLib.writeNetworkData(app.get('env') === 'development', save);
                } else {
                    // simply log power
                    influxLib.writePowerRaw(app.get('env') === 'development', save);
                }
                
            }
            //print("Power available: " + power);
            // Forcing first, then the battery: devices that are not forced only share
            // surplus once the battery allows it.
            const devices_allowed = getDeviceChargingStatus().enabled;
            const devices_to_consider = include_elements(devices_to_activate_priority_list,Object.keys(devices_to_activate_state));
            //print("Devices to consider: ",devices_to_consider);
            for (let i = 0; i < devices_to_consider.length; i++) {
                let device = devices_to_activate.filter(value => {
                    return value.uri == devices_to_consider[i];
                })[0];
                // A forced device skips the battery decision
                const device_allowed = devices_to_activate_state[device.uri].force_mode || devices_allowed;
                // Check for connection
                if (device_allowed && is_device_connected(device.time_limit, devices_to_activate_state[device.uri].last_call, 20)) {
                    // Normal mode
                    if (devices_to_activate_state[device.uri].type == 'normal') {
                        let to_activate = normalDecision(device, power);
                        if (devices_to_activate_state[device.uri].force_mode) {
                            to_activate = (devices_to_activate_state[device.uri].force_mode_percent >= 1);
                        }
                        if (!check_environment_for_power_consumption(device)) {
                            to_activate = false;
                        }
                        devices_to_activate_state[device.uri].requested_toggle = to_activate;
                        devices_to_activate_state[device.uri].requested_power = (to_activate) ? device.power_limit : 0; 
                        //print("[" + device.uri + "] activated = " + to_activate + ", power = " + devices_to_activate_state[device.uri].requested_power + " W (100%)")
                    }
                    // Advanced mode
                    if (devices_to_activate_state[device.uri].type == 'advanced') {
                        let { alpha, percentage } = advancedDecision(device, power);
                        devices_to_activate_state[device.uri].requested_alpha = alpha;
                        devices_to_activate_state[device.uri].requested_power = percentage*device.power_limit;
                        if (devices_to_activate_state[device.uri].force_mode) {
                            let { alpha, percentage } = advancedDecision(device, -devices_to_activate_state[device.uri].force_mode_percent*device.power_limit);
                            devices_to_activate_state[device.uri].requested_alpha = alpha;
                            devices_to_activate_state[device.uri].requested_power = percentage*device.power_limit;
                        }
                        if (!check_environment_for_power_consumption(device)) {
                            devices_to_activate_state[device.uri].requested_alpha = 128;
                            devices_to_activate_state[device.uri].requested_power = 0;
                        }
                        //print("[" + device.uri + "] alpha = " + alpha + ", power = " + devices_to_activate_state[device.uri].requested_power + " W (" + percentage*100 + "%)")
                    }
                } else {
                    // Block charging when the battery gate is closed for a device that is not forced,
                    // or when the device is disconnected.
                    disableDeviceCharging(devices_to_activate_state[device.uri]);
                }
                if (devices_to_activate_state[device.uri].force_mode == false) { // Prevent from considering forced power as available power
                    power += devices_to_activate_state[device.uri].requested_power; 
                }
                //print("Power to consider after '" + device.uri + "' : " + power);
            }
    });
},getPowerData.powerRequestThreshold);

}

function start() {
    const server = app.listen(port, () => {
        console.log(require('server-welcome')(port, 'Solar panel watch'));
    });
    startBackgroundTasks();
    return server;
}

if (require.main === module) {
    start();
}

module.exports = {
    app,
    start,
    startBackgroundTasks,
    getDeviceChargingStatus,
    isPowerDataAvailable: () => powerDataAvailable
};

