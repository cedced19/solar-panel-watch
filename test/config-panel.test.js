const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const {createAuth, readOptions} = require('../lib/auth');
const {createConfigPanel, validateConfig, validateDevices} = require('../lib/config-panel');

const initialConfig = {
    timezone: 'Europe/Paris',
    influx_update_delay: 15000,
    auth: {mails: ['cedced19@gmail.com'], sender: {user: 'robot@gmail.com', pass: 'app-pass'}, jwt_secret: 'test-secret'}
};

const initialDevices = [
    {uri: 'heater', power_limit: 2600, time_limit: 2500, power_threshold_percentage: 0.1, ids: ['abc12'], priority: 1, min_alpha: 40},
    {uri: 'boiler', power_limit: 2300, time_limit: 2500, power_threshold_percentage: 0.12, ids: ['def34'], priority: 2}
];

// checkSender(options) stands for the SMTP login check of a new sender.
async function startPanel(t, {config = initialConfig, checkSender = () => Promise.resolve()} = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-panel-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    fs.chmodSync(configPath, 0o640);
    const devicesPath = path.join(dir, 'devices-to-activate.json');
    fs.writeFileSync(devicesPath, JSON.stringify(initialDevices, null, 4));
    const sent = [];
    const auth = createAuth(readOptions(config), {
        mailer: (options, to, code) => {
            sent.push({to, code, sender: options.senderUser});
            return Promise.resolve();
        },
        checkSender
    });
    let restarts = 0;
    const app = express();
    app.use(createConfigPanel({
        configPath, runningConfig: config, devicesPath, runningDevices: initialDevices, auth, restart: () => { restarts++; }
    }));
    const server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => {
        server.close();
        fs.rmSync(dir, {recursive: true, force: true});
    });

    async function call(method, url, {body, token} = {}) {
        const headers = {'Content-Type': 'application/json'};
        if (token) headers.Authorization = 'Bearer ' + token;
        const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
            method,
            headers,
            body: typeof body === 'string' ? body : body && JSON.stringify(body)
        });
        return {status: res.status, body: await res.json()};
    }

    async function login() {
        await call('POST', '/api/auth/request', {body: {email: 'cedced19@gmail.com'}});
        const res = await call('POST', '/api/auth/verify', {body: {email: 'cedced19@gmail.com', code: sent.at(-1).code}});
        return res.body.token;
    }

    return {call, login, sent, configPath, devicesPath, restarts: () => restarts};
}

test('validateConfig keeps at least one valid allowed email', () => {
    assert.equal(validateConfig({auth: {mails: ['a@b.fr']}}), null);
    assert.deepEqual(validateConfig([]), {error: 'config-object'});
    assert.deepEqual(validateConfig({}), {error: 'mails-required'});
    assert.deepEqual(validateConfig({auth: {mails: []}}), {error: 'mails-required'});
    assert.deepEqual(validateConfig({auth: {mails: ['a@b.fr', 'nope']}}), {error: 'invalid-mail', value: 'nope'});
});

test('validateDevices accepts the devices main.js can run and names the first one it cannot', () => {
    assert.equal(validateDevices(initialDevices), null);
    assert.equal(validateDevices([]), null);
    assert.deepEqual(validateDevices({}), {error: 'devices-array'});
    assert.deepEqual(validateDevices([initialDevices[0], 'boiler']), {error: 'device-object', value: '#2'});
    assert.deepEqual(validateDevices([{...initialDevices[0], uri: 'a/b'}]), {error: 'device-uri', value: 'a/b'});
    assert.deepEqual(validateDevices([{...initialDevices[0], uri: undefined}]), {error: 'device-uri', value: '#1'});
    assert.deepEqual(validateDevices([initialDevices[0], initialDevices[0]]), {error: 'device-duplicate', value: 'heater'});
    const broken = (change) => validateDevices([{...initialDevices[0], ...change}]);
    assert.deepEqual(broken({power_limit: 0}), {error: 'device-field', value: 'heater.power_limit'});
    assert.deepEqual(broken({time_limit: '2500'}), {error: 'device-field', value: 'heater.time_limit'});
    assert.deepEqual(broken({power_threshold_percentage: 4}), {error: 'device-field', value: 'heater.power_threshold_percentage'});
    assert.deepEqual(broken({priority: null}), {error: 'device-field', value: 'heater.priority'});
    assert.deepEqual(broken({ids: 'abc12'}), {error: 'device-field', value: 'heater.ids'});
    assert.deepEqual(broken({ids: [12]}), {error: 'device-field', value: 'heater.ids'});
});

test('the config API requires a login while the request endpoint does not reveal the whitelist', async (t) => {
    const panel = await startPanel(t);

    assert.equal((await panel.call('GET', '/api/config')).status, 401);
    assert.equal((await panel.call('GET', '/api/config', {token: 'bad.token.value'})).status, 401);
    assert.equal((await panel.call('PUT', '/api/config', {body: {}})).status, 401);
    assert.equal((await panel.call('GET', '/api/config/devices')).status, 401);
    assert.equal((await panel.call('PUT', '/api/config/devices', {body: []})).status, 401);
    assert.equal((await panel.call('POST', '/api/config/restart')).status, 401);
    assert.equal((await panel.call('GET', '/api/auth/me')).status, 401);

    const unknown = await panel.call('POST', '/api/auth/request', {body: {email: 'someone@example.com'}});
    assert.deepEqual(unknown, {status: 200, body: {ok: true}});
    assert.equal(panel.sent.length, 0);

    const wrongCode = await panel.call('POST', '/api/auth/verify', {body: {email: 'someone@example.com', code: '123456'}});
    assert.deepEqual(wrongCode, {status: 400, body: {ok: false, error: 'invalid-code'}});

    const token = await panel.login();
    assert.deepEqual(await panel.call('GET', '/api/auth/me', {token}), {status: 200, body: {ok: true, email: 'cedced19@gmail.com'}});
    assert.deepEqual(await panel.call('GET', '/api/config', {token}), {
        status: 200, body: {ok: true, config: initialConfig, restart_required: false}
    });
});

test('saving writes config.json with a backup, applies the whitelist and flags a restart', async (t) => {
    const panel = await startPanel(t);
    const token = await panel.login();

    const invalid = await panel.call('PUT', '/api/config', {token, body: {...initialConfig, auth: {mails: []}}});
    assert.deepEqual(invalid, {status: 400, body: {ok: false, error: 'mails-required'}});
    assert.deepEqual(JSON.parse(fs.readFileSync(panel.configPath, 'utf8')), initialConfig);
    assert.deepEqual((await panel.call('PUT', '/api/config', {token, body: '{oops'})).body, {ok: false, error: 'invalid-json'});

    const sameSettings = {...initialConfig, auth: {...initialConfig.auth, mails: ['cedced19@gmail.com', 'friend@example.com']}};
    const saved = await panel.call('PUT', '/api/config', {token, body: sameSettings});
    assert.deepEqual(saved.body, {ok: true, config: sameSettings, restart_required: false});
    assert.deepEqual(JSON.parse(fs.readFileSync(panel.configPath, 'utf8')), sameSettings);
    assert.deepEqual(JSON.parse(fs.readFileSync(panel.configPath + '.bak', 'utf8')), initialConfig);
    assert.equal(fs.statSync(panel.configPath).mode & 0o777, 0o640);
    assert.equal(fs.existsSync(panel.configPath + '.tmp'), false);

    await panel.call('POST', '/api/auth/request', {body: {email: 'friend@example.com'}});
    assert.equal(panel.sent.at(-1).to, 'friend@example.com');

    const newDelay = {...sameSettings, influx_update_delay: 30000};
    assert.equal((await panel.call('PUT', '/api/config', {token, body: newDelay})).body.restart_required, true);
    assert.equal((await panel.call('GET', '/api/config', {token})).body.restart_required, true);

    // Removing the logged-in email revokes its token right away.
    const withoutMe = {...newDelay, auth: {...newDelay.auth, mails: ['friend@example.com']}};
    assert.equal((await panel.call('PUT', '/api/config', {token, body: withoutMe})).status, 200);
    assert.equal((await panel.call('GET', '/api/config', {token})).status, 401);
});

test('devices-to-activate.json is read and saved like config.json, with its own checks and backup', async (t) => {
    const panel = await startPanel(t);
    const token = await panel.login();
    const readSaved = () => JSON.parse(fs.readFileSync(panel.devicesPath, 'utf8'));

    assert.deepEqual(await panel.call('GET', '/api/config/devices', {token}), {
        status: 200, body: {ok: true, devices: initialDevices, restart_required: false}
    });

    const invalid = await panel.call('PUT', '/api/config/devices', {token, body: [{...initialDevices[0], power_limit: -5}]});
    assert.deepEqual(invalid, {status: 400, body: {ok: false, error: 'device-field', value: 'heater.power_limit'}});
    assert.deepEqual((await panel.call('PUT', '/api/config/devices', {token, body: {}})).body, {ok: false, error: 'devices-array'});
    assert.deepEqual((await panel.call('PUT', '/api/config/devices', {token, body: '{oops'})).body, {ok: false, error: 'invalid-json'});
    assert.deepEqual(readSaved(), initialDevices);
    assert.equal(fs.existsSync(panel.devicesPath + '.bak'), false);

    // The margin of the heater is raised: every device setting is read at startup.
    const edited = [{...initialDevices[0], power_threshold_percentage: 0.2}, initialDevices[1]];
    const saved = await panel.call('PUT', '/api/config/devices', {token, body: edited});
    assert.deepEqual(saved, {status: 200, body: {ok: true, devices: edited, restart_required: true}});
    assert.deepEqual(readSaved(), edited);
    assert.deepEqual(JSON.parse(fs.readFileSync(panel.devicesPath + '.bak', 'utf8')), initialDevices);
    assert.equal(fs.existsSync(panel.devicesPath + '.tmp'), false);

    // The restart flag covers both files, whichever one is being edited.
    assert.equal((await panel.call('GET', '/api/config', {token})).body.restart_required, true);
    assert.equal((await panel.call('PUT', '/api/config/devices', {token, body: initialDevices})).body.restart_required, false);
    assert.equal((await panel.call('GET', '/api/config', {token})).body.restart_required, false);

    const delay = {...initialConfig, influx_update_delay: 30000};
    assert.equal((await panel.call('PUT', '/api/config', {token, body: delay})).body.restart_required, true);
    assert.equal((await panel.call('GET', '/api/config/devices', {token})).body.restart_required, true);
});

test('a devices file that cannot be read does not block config.json', async (t) => {
    const panel = await startPanel(t);
    const token = await panel.login();
    fs.writeFileSync(panel.devicesPath, '[{');
    assert.deepEqual(await panel.call('GET', '/api/config/devices', {token}), {status: 500, body: {ok: false, error: 'read-failed'}});
    assert.deepEqual(await panel.call('GET', '/api/config', {token}), {
        status: 200, body: {ok: true, config: initialConfig, restart_required: false}
    });
});

test('the first login configures the sender, saved only once its code is verified', async (t) => {
    const unconfigured = {...initialConfig, auth: {...initialConfig.auth, sender: {user: '', pass: ''}}};
    const checked = [];
    const panel = await startPanel(t, {
        config: unconfigured,
        checkSender: (options) => {
            checked.push(options.senderUser);
            return options.senderPass === 'abcdefgh' ? Promise.resolve() : Promise.reject(new Error('535 Invalid login'));
        }
    });
    const readSaved = () => JSON.parse(fs.readFileSync(panel.configPath, 'utf8'));

    assert.deepEqual((await panel.call('GET', '/api/auth/status')).body, {ok: true, sender_configured: false});
    assert.deepEqual(await panel.call('POST', '/api/auth/request', {body: {email: 'cedced19@gmail.com'}}), {
        status: 400, body: {ok: false, error: 'sender-required', sender_configured: false}
    });
    const badSender = {user: 'robot@gmail.com', pass: 'bad-pass'};
    assert.deepEqual(await panel.call('POST', '/api/auth/request', {body: {email: 'cedced19@gmail.com', sender: badSender}}), {
        status: 400, body: {ok: false, error: 'sender-failed', detail: '535 Invalid login'}
    });
    assert.equal(panel.sent.length, 0);

    // Gmail displays app passwords in groups of four: spaces are dropped.
    const sender = {user: ' robot@gmail.com ', pass: 'abcd efgh'};
    const stranger = await panel.call('POST', '/api/auth/request', {body: {email: 'someone@example.com', sender}});
    assert.deepEqual(stranger, {status: 200, body: {ok: true}});
    await panel.call('POST', '/api/auth/request', {body: {email: 'cedced19@gmail.com', sender}});
    assert.deepEqual(panel.sent, [{to: 'cedced19@gmail.com', code: panel.sent[0].code, sender: 'robot@gmail.com'}]);
    assert.deepEqual(checked, ['robot@gmail.com', 'robot@gmail.com', 'robot@gmail.com']);

    const wrong = panel.sent[0].code === '000000' ? '111111' : '000000';
    await panel.call('POST', '/api/auth/verify', {body: {email: 'cedced19@gmail.com', code: wrong}});
    assert.deepEqual(readSaved().auth.sender, {user: '', pass: ''}, 'not saved before a valid code');

    const verified = await panel.call('POST', '/api/auth/verify', {body: {email: 'cedced19@gmail.com', code: panel.sent[0].code}});
    assert.equal(verified.status, 200);
    assert.deepEqual(readSaved().auth.sender, {user: 'robot@gmail.com', pass: 'abcdefgh'});
    assert.deepEqual((await panel.call('GET', '/api/auth/status')).body, {ok: true, sender_configured: true});
    assert.equal((await panel.call('GET', '/api/config', {token: verified.body.token})).body.restart_required, false);

    // From now on the saved sender is used and a typed one is ignored.
    await panel.call('POST', '/api/auth/request', {body: {email: 'cedced19@gmail.com', sender: badSender}});
    assert.equal(panel.sent.at(-1).sender, 'robot@gmail.com');
    assert.equal(checked.length, 3);
});

test('a logged-in user can restart the server', async (t) => {
    const panel = await startPanel(t);
    const token = await panel.login();
    assert.deepEqual(await panel.call('POST', '/api/config/restart', {token}), {status: 200, body: {ok: true}});
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(panel.restarts(), 1);
});

test('the configuration and force pages are public, their APIs need a login and other pages stay open', async (t) => {
    const main = require('../main');
    const server = await new Promise((resolve) => {
        const listening = main.app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;

    const page = await fetch(`${base}/config/`, {headers: {'accept-language': 'fr'}});
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Connexion pour modifier la configuration/);
    assert.match(html, /\/assets\/login\.js/);
    assert.match(html, /\/assets\/config-panel\.js/);
    assert.doesNotMatch(html, /cedced19@gmail\.com/);

    const force = await fetch(`${base}/force/`, {headers: {'accept-language': 'fr'}});
    assert.equal(force.status, 200);
    const forceHtml = await force.text();
    assert.match(forceHtml, /Connexion pour forcer les appareils/);
    assert.match(forceHtml, /\/assets\/login\.js/);
    assert.match(forceHtml, /\/assets\/force\.js/);
    assert.doesNotMatch(forceHtml, /type="password" id="password"/);

    assert.equal((await fetch(`${base}/nomenclature/`)).status, 200);
    assert.equal((await fetch(`${base}/api/config`)).status, 401);
    assert.equal((await fetch(`${base}/api/config/devices`)).status, 401);
    assert.equal((await fetch(`${base}/api/data-force`)).status, 401);
    assert.equal((await fetch(`${base}/api/device/chauffe-eau/force`, {method: 'DELETE'})).status, 401);
});
