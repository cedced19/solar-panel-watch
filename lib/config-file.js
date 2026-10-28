// config.json holds this installation's settings and secrets and is not
// tracked by git. config-default.json is the tracked template: on start, a
// missing config.json is created from it and keys added to the template since
// are copied into an existing config.json. Values already set are never changed,
// except the InfluxDB settings of older versions, renamed or removed once.
//
// devices-to-activate.json works the same way with devices-to-activate-default.json,
// except that an existing file is never completed (see ensureDevices).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DEFAULT_PATH = path.join(ROOT, 'config-default.json');
const DEVICES_PATH = path.join(ROOT, 'devices-to-activate.json');
const DEVICES_DEFAULT_PATH = path.join(ROOT, 'devices-to-activate-default.json');

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Settings of the InfluxDB era: the renamed ones keep their value, the removed
// ones only served the connection to InfluxDB.
const RENAMED_KEYS = {influx_default_tag: 'victoria_default_tag', influx_update_delay: 'victoria_update_delay'};
const REMOVED_KEYS = ['influx_tocken', 'influx_org', 'influx_bucket', 'influx_url'];

// Renames and removes those keys in config, keeping the order of the others
// (a value already set under the new name wins). Returns what was done.
function migrateKeys(config) {
    const entries = Object.entries(config);
    const changes = [];
    entries.forEach(([key]) => delete config[key]);
    for (const [key, value] of entries) {
        if (REMOVED_KEYS.includes(key)) {
            changes.push('removed ' + key);
        } else if (Object.hasOwn(RENAMED_KEYS, key)) {
            const name = RENAMED_KEYS[key];
            if (!entries.some(([other]) => other === name)) config[name] = value;
            changes.push('renamed ' + key + ' to ' + name);
        } else {
            config[key] = value;
        }
    }
    return changes;
}

// Copies into config every key of defaults it lacks, recursing into objects.
// Returns the dotted names of the added keys.
function fillDefaults(config, defaults, prefix = '') {
    const added = [];
    Object.keys(defaults).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(config, key)) {
            config[key] = JSON.parse(JSON.stringify(defaults[key]));
            added.push(prefix + key);
        } else if (isPlainObject(config[key]) && isPlainObject(defaults[key])) {
            added.push(...fillDefaults(config[key], defaults[key], prefix + key + '.'));
        }
    });
    return added;
}

// Gives a file written by this process the owner and mode of the original, so
// a container running as root does not leave a root-owned config.json on the host.
function keepOwnership(target, stat) {
    fs.chmodSync(target, stat.mode & 0o7777);
    try {
        fs.chownSync(target, stat.uid, stat.gid);
    } catch (err) {
        if (err.code !== 'EPERM') throw err; // not root: the file is already ours
    }
}

// Writes config (an object, or the array of devices) to file, keeping the previous version in <file>.bak and
// swapping the new one in atomically.
function writeConfig(file, config) {
    const stat = fs.existsSync(file) ? fs.statSync(file) : null;
    if (stat) {
        fs.copyFileSync(file, file + '.bak');
        keepOwnership(file + '.bak', stat);
    }
    fs.writeFileSync(file + '.tmp', JSON.stringify(config, null, 4) + '\n');
    if (stat) keepOwnership(file + '.tmp', stat);
    fs.renameSync(file + '.tmp', file);
}

function readConfig(file = CONFIG_PATH) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Creates or completes config.json from config-default.json, migrates the
// InfluxDB settings and generates auth.jwt_secret when it is empty. Writes only
// when something changed.
function ensureConfig({configPath = CONFIG_PATH, defaultPath = DEFAULT_PATH} = {}) {
    const defaults = readConfig(defaultPath);
    const exists = fs.existsSync(configPath);
    const config = exists ? readConfig(configPath) : {};
    const migrated = migrateKeys(config);
    const added = fillDefaults(config, defaults);
    let secretCreated = false;
    if (isPlainObject(config.auth) && !config.auth.jwt_secret) {
        config.auth.jwt_secret = crypto.randomBytes(32).toString('hex');
        secretCreated = true;
    }
    if (migrated.length) {
        console.log(`[config] InfluxDB settings in ${path.basename(configPath)}: ${migrated.join(', ')}`);
    }
    if (!exists) {
        console.log(`[config] Created ${path.basename(configPath)} from ${path.basename(defaultPath)}.`);
    } else if (added.length) {
        console.log(`[config] Added to ${path.basename(configPath)} from ${path.basename(defaultPath)}: ${added.join(', ')}`);
    }
    if (!exists || migrated.length || added.length || secretCreated) writeConfig(configPath, config);
    return config;
}

// Creates devices-to-activate.json from devices-to-activate-default.json when it
// is missing. An existing file is left as it is, even if the template gained
// keys since: the optional ones (max_energy_val, max_control_var_val, ...) switch
// a feature on, so a device without them lacks them on purpose.
function ensureDevices({devicesPath = DEVICES_PATH, defaultPath = DEVICES_DEFAULT_PATH} = {}) {
    if (!fs.existsSync(devicesPath)) {
        writeConfig(devicesPath, readConfig(defaultPath));
        console.log(`[config] Created ${path.basename(devicesPath)} from ${path.basename(defaultPath)}.`);
    }
    return readConfig(devicesPath);
}

module.exports = {
    CONFIG_PATH, DEFAULT_PATH, DEVICES_PATH, DEVICES_DEFAULT_PATH,
    migrateKeys, fillDefaults, writeConfig, readConfig, ensureConfig, ensureDevices
};
