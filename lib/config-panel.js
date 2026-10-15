// Online editor for config.json at /config/. It is the only part of the app
// behind a login (email + one-time code, see lib/auth.js): the page itself is
// public, its data goes through /api/config which requires a Bearer token.
//
// Whitelist changes (auth.*) apply as soon as they are saved; every other
// setting is read at startup, so the panel offers a restart once saved.

const fs = require('fs');
const express = require('express');
const {readOptions, normalize} = require('./auth');

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

function readConfigFile(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Keeps the previous version in <file>.bak, then swaps the new one in atomically.
function writeConfigFile(file, config) {
    fs.copyFileSync(file, file + '.bak');
    fs.writeFileSync(file + '.tmp', JSON.stringify(config, null, 4) + '\n');
    fs.renameSync(file + '.tmp', file);
}

function bearerToken(req) {
    const header = req.get('Authorization') || '';
    return header.startsWith('Bearer ') ? header.slice(7) : '';
}

// options.configPath: config.json to edit
// options.runningConfig: config the process started with (to flag a needed restart)
// options.auth: instance from lib/auth.js createAuth
// options.restart: called after answering a restart request (default: exit,
//   docker/systemd "restart: always" brings the app back)
function createConfigPanel(options) {
    const {configPath, auth} = options;
    const runningConfig = JSON.parse(JSON.stringify(options.runningConfig));
    const restart = options.restart || (() => process.exit(0));
    const router = express.Router();
    const json = express.json({limit: '256kb'});

    function requireLogin(req, res, next) {
        const email = auth.parse(bearerToken(req));
        if (!email) return res.status(401).json({ok: false, error: 'not-authenticated'});
        req.authEmail = email;
        next();
    }

    router.get('/config/', (req, res) => {
        res.render('config', {otp_ttl_minutes: auth.otpTtlMinutes()});
    });

    // Always answers ok so callers cannot probe which addresses are allowed.
    router.post('/api/auth/request', json, (req, res) => {
        const email = normalize(req.body && req.body.email);
        if (!email) return res.status(400).json({ok: false, error: 'email-required'});
        auth.request(email).catch((err) => {
            if (err.code !== 'not-allowed') console.error('[auth] Cannot send login code:', err.message);
        });
        res.json({ok: true});
    });

    router.post('/api/auth/verify', json, (req, res) => {
        const email = normalize(req.body && req.body.email);
        const code = String((req.body && req.body.code) || '').trim();
        if (!email || !code) return res.status(400).json({ok: false, error: 'code-required'});
        try {
            res.json({ok: true, token: auth.verify(email, code), email});
        } catch (err) {
            const status = err.code === 'invalid-code' ? 400 : 401;
            res.status(status).json({ok: false, error: err.code || 'invalid-code'});
        }
    });

    router.get('/api/auth/me', requireLogin, (req, res) => {
        res.json({ok: true, email: req.authEmail});
    });

    router.get('/api/config', requireLogin, (req, res) => {
        let config;
        try {
            config = readConfigFile(configPath);
        } catch (err) {
            console.error('[config] Cannot read config.json:', err.message);
            return res.status(500).json({ok: false, error: 'read-failed'});
        }
        res.set('Cache-Control', 'no-store');
        res.json({ok: true, config, restart_required: needsRestart(runningConfig, config)});
    });

    router.put('/api/config', requireLogin, json, (req, res) => {
        const config = req.body;
        const invalid = validateConfig(config);
        if (invalid) return res.status(400).json({ok: false, ...invalid});
        try {
            writeConfigFile(configPath, config);
        } catch (err) {
            console.error('[config] Cannot write config.json:', err.message);
            return res.status(500).json({ok: false, error: 'write-failed'});
        }
        auth.configure(readOptions(config));
        console.log(`[config] config.json updated by ${req.authEmail}`);
        res.json({ok: true, config, restart_required: needsRestart(runningConfig, config)});
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

module.exports = {createConfigPanel, validateConfig, needsRestart};
