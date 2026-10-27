const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {fillDefaults, ensureConfig, ensureDevices} = require('../lib/config-file');
const {validateDevices} = require('../lib/config-panel');

const defaults = {
    timezone: 'Europe/Paris',
    influx_update_delay: 15000,
    zendure_meter: {host: '192.168.0.48', power_scale: 1},
    auth: {mails: ['cedced19@gmail.com'], sender: {user: '', pass: ''}, jwt_secret: ''}
};

function tempFiles(t, config) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-file-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const files = {configPath: path.join(dir, 'config.json'), defaultPath: path.join(dir, 'config-default.json')};
    fs.writeFileSync(files.defaultPath, JSON.stringify(defaults, null, 4));
    if (config) fs.writeFileSync(files.configPath, JSON.stringify(config, null, 4));
    return files;
}

test('the tracked config-default.json lists every key of the local config.json', () => {
    const tracked = JSON.parse(fs.readFileSync(path.join(__dirname, '../config-default.json'), 'utf8'));
    assert.deepEqual(tracked.auth.sender, {user: '', pass: ''});
    assert.equal(tracked.auth.jwt_secret, '');
    const local = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8'));
    assert.deepEqual(fillDefaults(JSON.parse(JSON.stringify(local)), tracked), []);
});

test('fillDefaults adds missing keys, also nested ones, and never changes a set value', () => {
    const config = {timezone: 'UTC', zendure_meter: {host: '10.0.0.2'}, auth: {mails: ['me@example.com']}};
    assert.deepEqual(fillDefaults(config, defaults), [
        'influx_update_delay', 'zendure_meter.power_scale', 'auth.sender', 'auth.jwt_secret'
    ]);
    assert.deepEqual(config, {
        timezone: 'UTC',
        influx_update_delay: 15000,
        zendure_meter: {host: '10.0.0.2', power_scale: 1},
        auth: {mails: ['me@example.com'], sender: {user: '', pass: ''}, jwt_secret: ''}
    });
    config.auth.sender.user = 'changed';
    assert.equal(defaults.auth.sender.user, '', 'defaults are copied, not shared');
});

test('ensureConfig creates config.json from the defaults with a random JWT secret', (t) => {
    const files = tempFiles(t);
    const config = ensureConfig(files);
    assert.match(config.auth.jwt_secret, /^[0-9a-f]{64}$/);
    assert.deepEqual({...config, auth: {...config.auth, jwt_secret: ''}}, defaults);
    assert.deepEqual(JSON.parse(fs.readFileSync(files.configPath, 'utf8')), config);
    assert.equal(fs.existsSync(files.configPath + '.bak'), false);
});

test('ensureConfig completes an existing config.json and leaves a complete one untouched', (t) => {
    const files = tempFiles(t, {timezone: 'UTC', auth: {mails: ['me@example.com'], jwt_secret: 'kept'}});
    const completed = ensureConfig(files);
    assert.equal(completed.timezone, 'UTC');
    assert.equal(completed.influx_update_delay, 15000);
    assert.deepEqual(completed.auth, {mails: ['me@example.com'], jwt_secret: 'kept', sender: {user: '', pass: ''}});
    assert.equal(fs.existsSync(files.configPath + '.bak'), true);

    const before = fs.readFileSync(files.configPath, 'utf8');
    fs.rmSync(files.configPath + '.bak');
    assert.deepEqual(ensureConfig(files), completed);
    assert.equal(fs.readFileSync(files.configPath, 'utf8'), before);
    assert.equal(fs.existsSync(files.configPath + '.bak'), false, 'nothing is written when nothing changed');
});

const devicesDefault = [
    {uri: 'heater', power_limit: 2600, time_limit: 2500, power_threshold_percentage: 0.04, ids: ['abc12'], priority: 1}
];

function tempDevices(t, devices) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devices-file-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const files = {devicesPath: path.join(dir, 'devices-to-activate.json'), defaultPath: path.join(dir, 'devices-to-activate-default.json')};
    fs.writeFileSync(files.defaultPath, JSON.stringify(devicesDefault, null, 4));
    if (devices) fs.writeFileSync(files.devicesPath, JSON.stringify(devices, null, 4));
    return files;
}

test('the tracked devices-to-activate-default.json holds devices the app can run', () => {
    const tracked = JSON.parse(fs.readFileSync(path.join(__dirname, '../devices-to-activate-default.json'), 'utf8'));
    assert.equal(validateDevices(tracked), null);
    assert.ok(tracked.length > 0);
});

test('ensureDevices creates devices-to-activate.json from the template when it is missing', (t) => {
    const files = tempDevices(t);
    assert.deepEqual(ensureDevices(files), devicesDefault);
    assert.deepEqual(JSON.parse(fs.readFileSync(files.devicesPath, 'utf8')), devicesDefault);
    assert.equal(fs.existsSync(files.devicesPath + '.bak'), false);
});

test('ensureDevices never touches an existing file, even one that lacks keys of the template', (t) => {
    const edited = [{uri: 'heater', power_limit: 1000, time_limit: 2500, ids: ['abc12'], priority: 1}, {uri: 'pump'}];
    const files = tempDevices(t, edited);
    const before = fs.readFileSync(files.devicesPath, 'utf8');
    assert.deepEqual(ensureDevices(files), edited);
    assert.equal(fs.readFileSync(files.devicesPath, 'utf8'), before);
    assert.equal(fs.existsSync(files.devicesPath + '.bak'), false);
});
