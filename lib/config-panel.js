// Online editor for config.json and devices-to-activate.json at /config/, behind the login (email + one-time
// code, see lib/auth.js) it shares with the force page: the page itself is
// public, its data goes through /api/config which requires a Bearer token.
// The /api/auth/* routes below serve both pages.
//
// While no sender (auth.sender) is configured, the login form also asks for
// one: the code is sent through it, and it is saved to config.json once that
// code is verified, so the sender is known to work and never has to be committed.
//
// Whitelist and sender changes (auth.*) apply as soon as they are saved; every
// other setting, and the devices, are read at startup, so the panel offers a
// restart once saved.

const path = require('path');
const express = require('express');
const {readOptions, normalize} = require('./auth');
const {readConfig, writeConfig} = require('./config-file');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Returns {error, value?} for a config that must not be written, else null.
// Keeping at least one valid email in auth.mails prevents locking everyone out.
function validateConfig(config) {
    if (!isPlainObject(config)) return {error: 'config-object'};
    const mails = isPlainObject(config.auth) ? config.auth.mails : undefined;
    if (!Array.isArray(mails) || mails.length === 0) return {error: 'mails-required'};
    const invalid = mails.find((mail) => typeof mail !== 'string' || !EMAIL_PATTERN.test(mail.trim()));
    if (invalid !== undefined) return {error: 'invalid-mail', value: invalid};
    return null;
}

// Settings other than auth.* only take effect after a restart.
function needsRestart(running, saved) {
    const withoutAuth = (config) => JSON.stringify({...config, auth: undefined});
    return withoutAuth(running) !== withoutAuth(saved);
}

const DEVICE_URI = /^[A-Za-z0-9_-]+$/; // used in URLs and as the name of reload_files/<uri>.json

function isPositive(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Name of the first field main.js cannot work without that is missing or of the
// wrong kind, else null. The optional ones (min_alpha, max_energy_val, ...) are left to the editor.
function invalidDeviceField(device) {
    if (!isPositive(device.power_limit)) return 'power_limit';
    if (!isPositive(device.time_limit)) return 'time_limit';
    const margin = device.power_threshold_percentage;
    if (typeof margin !== 'number' || !(margin >= 0 && margin <= 1)) return 'power_threshold_percentage';
    if (typeof device.priority !== 'number' || !Number.isFinite(device.priority)) return 'priority';
    if (!Array.isArray(device.ids) || device.ids.some((id) => typeof id !== 'string')) return 'ids';
    return null;
}

// Returns {error, value?} for a devices file that must not be written, else
// null. The app reads the file at startup and would keep failing to start on a
// device it cannot use.
function validateDevices(devices) {
    if (!Array.isArray(devices)) return {error: 'devices-array'};
    const uris = new Set();
    for (let index = 0; index < devices.length; index++) {
        const device = devices[index];
        const label = isPlainObject(device) && typeof device.uri === 'string' ? device.uri : '#' + (index + 1);
        if (!isPlainObject(device)) return {error: 'device-object', value: label};
        if (typeof device.uri !== 'string' || !DEVICE_URI.test(device.uri)) return {error: 'device-uri', value: label};
        if (uris.has(device.uri)) return {error: 'device-duplicate', value: device.uri};
        uris.add(device.uri);
        const field = invalidDeviceField(device);
        if (field) return {error: 'device-field', value: device.uri + '.' + field};
    }
    return null;
}

function devicesChanged(running, saved) {
    return JSON.stringify(running) !== JSON.stringify(saved);
}

// Reads the {user, pass} sender typed on the first login, or null if incomplete.
function readSender(body) {
    const sender = isPlainObject(body && body.sender) ? body.sender : {};
    const user = typeof sender.user === 'string' ? sender.user.trim() : '';
    const pass = typeof sender.pass === 'string' ? sender.pass.replace(/\s+/g, '') : ''; // Gmail shows app passwords in groups
    return user && pass ? {senderUser: user, senderPass: pass} : null;
}

// options.configPath: config.json to edit
// options.runningConfig: config the process started with (to flag a needed restart)
// options.devicesPath, options.runningDevices: the same for devices-to-activate.json
// options.auth: instance from lib/auth.js createAuth
// options.restart: called after answering a restart request (default: exit,
//   docker/systemd "restart: always" brings the app back)
function createConfigPanel(options) {
    const {configPath, devicesPath, auth} = options;
    const {requireLogin} = auth;
    const runningConfig = JSON.parse(JSON.stringify(options.runningConfig));
    const runningDevices = JSON.parse(JSON.stringify(options.runningDevices));
    const restart = options.restart || (() => process.exit(0));
    const pendingSenders = new Map(); // email -> sender typed on the first login
    const router = express.Router();
    const json = express.json({limit: '256kb'});

    // Writes config.json and applies its auth section right away.
    function saveConfig(config) {
        writeConfig(configPath, config);
        auth.configure(readOptions(config));
    }

    function saveSender(email, sender) {
        const config = readConfig(configPath);
        config.auth = {...config.auth, sender: {user: sender.senderUser, pass: sender.senderPass}};
        saveConfig(config);
        console.log(`[config] Sender ${sender.senderUser} saved after the first login of ${email}`);
    }

    router.get('/config/', (req, res) => {
        res.render('config', {otp_ttl_minutes: auth.otpTtlMinutes(), sender_configured: auth.senderConfigured()});
    });

    router.get('/api/auth/status', (req, res) => {
        res.json({ok: true, sender_configured: auth.senderConfigured()});
    });

    // Always answers ok for a working sender so callers cannot probe which
    // addresses are allowed.
    router.post('/api/auth/request', json, async (req, res) => {
        const email = normalize(req.body && req.body.email);
        if (!email) return res.status(400).json({ok: false, error: 'email-required'});
        let sender;
        if (!auth.senderConfigured()) {
            sender = readSender(req.body);
            if (!sender) return res.status(400).json({ok: false, error: 'sender-required', sender_configured: false});
            try {
                await auth.checkSender(sender);
            } catch (err) {
                return res.status(400).json({ok: false, error: 'sender-failed', detail: err.message});
            }
            if (auth.allowed(email)) pendingSenders.set(email, sender);
        }
        auth.request(email, sender).catch((err) => {
            if (err.code !== 'not-allowed') console.error('[auth] Cannot send login code:', err.message);
        });
        res.json({ok: true});
    });

    router.post('/api/auth/verify', json, (req, res) => {
        const email = normalize(req.body && req.body.email);
        const code = String((req.body && req.body.code) || '').trim();
        if (!email || !code) return res.status(400).json({ok: false, error: 'code-required'});
        let token;
        try {
            token = auth.verify(email, code);
        } catch (err) {
            const status = err.code === 'invalid-code' ? 400 : 401;
            return res.status(status).json({ok: false, error: err.code || 'invalid-code'});
        }
        const sender = pendingSenders.get(email);
        pendingSenders.delete(email);
        if (sender && !auth.senderConfigured()) {
            try {
                saveSender(email, sender);
            } catch (err) {
                console.error('[config] Cannot save the sender to config.json:', err.message);
            }
        }
        res.json({ok: true, token, email});
    });

    router.get('/api/auth/me', requireLogin, (req, res) => {
        res.json({ok: true, email: req.authEmail});
    });

    // Whether any saved file differs from what the process started with. A file
    // that cannot be read has nothing to restart for.
    function restartRequired() {
        return [[configPath, runningConfig, needsRestart], [devicesPath, runningDevices, devicesChanged]]
            .some(([file, running, changed]) => {
                try {
                    return changed(running, readConfig(file));
                } catch (err) {
                    return false;
                }
            });
    }

    // Serves one file at url: the answer holds its content under key.
    function serveFile(url, {file, key, validate, save}) {
        const name = path.basename(file);

        router.get(url, requireLogin, (req, res) => {
            let content;
            try {
                content = readConfig(file);
            } catch (err) {
                console.error(`[config] Cannot read ${name}:`, err.message);
                return res.status(500).json({ok: false, error: 'read-failed'});
            }
            res.set('Cache-Control', 'no-store');
            res.json({ok: true, [key]: content, restart_required: restartRequired()});
        });

        router.put(url, requireLogin, json, (req, res) => {
            const content = req.body;
            const invalid = validate(content);
            if (invalid) return res.status(400).json({ok: false, ...invalid});
            try {
                save(content);
            } catch (err) {
                console.error(`[config] Cannot write ${name}:`, err.message);
                return res.status(500).json({ok: false, error: 'write-failed'});
            }
            console.log(`[config] ${name} updated by ${req.authEmail}`);
            res.json({ok: true, [key]: content, restart_required: restartRequired()});
        });
    }

    serveFile('/api/config', {file: configPath, key: 'config', validate: validateConfig, save: saveConfig});
    serveFile('/api/config/devices', {
        file: devicesPath, key: 'devices', validate: validateDevices, save: (devices) => writeConfig(devicesPath, devices)
    });

    router.post('/api/config/restart', requireLogin, (req, res) => {
        console.log(`[config] Restart requested by ${req.authEmail}`);
        res.on('finish', () => setTimeout(restart, 300));
        res.json({ok: true});
    });

    // Malformed or oversized JSON bodies on the routes above.
    router.use('/api/', (err, req, res, next) => {
        if (!err.type || !err.type.startsWith('entity.')) return next(err);
        res.status(err.status || 400).json({ok: false, error: err.status === 413 ? 'too-large' : 'invalid-json'});
    });

    return router;
}

module.exports = {createConfigPanel, validateConfig, validateDevices, needsRestart};
