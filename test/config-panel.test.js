const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const {createAuth, readOptions} = require('../lib/auth');
const {createConfigPanel, validateConfig} = require('../lib/config-panel');

const initialConfig = {
    timezone: 'Europe/Paris',
    influx_update_delay: 15000,
    auth: {mails: ['cedced19@gmail.com'], jwt_secret: 'test-secret'}
};

async function startPanel(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-panel-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 4));
    const sent = [];
    const auth = createAuth(readOptions(initialConfig), {
        mailer: (options, to, code) => {
            sent.push({to, code});
            return Promise.resolve();
        }
    });
    let restarts = 0;
    const app = express();
    app.use(createConfigPanel({configPath, runningConfig: initialConfig, auth, restart: () => { restarts++; }}));
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

    return {call, login, sent, configPath, restarts: () => restarts};
}

test('validateConfig keeps at least one valid allowed email', () => {
    assert.equal(validateConfig({auth: {mails: ['a@b.fr']}}), null);
    assert.deepEqual(validateConfig([]), {error: 'config-object'});
    assert.deepEqual(validateConfig({}), {error: 'mails-required'});
    assert.deepEqual(validateConfig({auth: {mails: []}}), {error: 'mails-required'});
    assert.deepEqual(validateConfig({auth: {mails: ['a@b.fr', 'nope']}}), {error: 'invalid-mail', value: 'nope'});
});

test('the config API requires a login while the request endpoint does not reveal the whitelist', async (t) => {
    const panel = await startPanel(t);

    assert.equal((await panel.call('GET', '/api/config')).status, 401);
    assert.equal((await panel.call('GET', '/api/config', {token: 'bad.token.value'})).status, 401);
    assert.equal((await panel.call('PUT', '/api/config', {body: {}})).status, 401);
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

test('a logged-in user can restart the server', async (t) => {
    const panel = await startPanel(t);
    const token = await panel.login();
    assert.deepEqual(await panel.call('POST', '/api/config/restart', {token}), {status: 200, body: {ok: true}});
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(panel.restarts(), 1);
});

test('the configuration page is public and every other page stays without login', async (t) => {
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
    assert.match(html, /\/assets\/config-panel\.js/);
    assert.doesNotMatch(html, /cedced19@gmail\.com/);

    assert.equal((await fetch(`${base}/nomenclature/`)).status, 200);
    assert.equal((await fetch(`${base}/api/config`)).status, 401);
});
