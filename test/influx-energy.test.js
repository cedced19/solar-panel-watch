const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createRequire} = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('both energy queries reject asynchronous Influx errors instead of crashing', async () => {
    const filename = path.resolve(__dirname, '../lib/influx-lib.js');
    const requireFromLib = createRequire(filename);
    const failure = new Error('Influx query failed');
    const module = {exports: {}};
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, console,
        require(name) {
            if (name === '@influxdata/influxdb-client') {
                return {...requireFromLib(name), InfluxDB: class {
                    getQueryApi() {
                        return {queryRows(_query, observer) {
                            queueMicrotask(() => observer.error(failure));
                        }};
                    }
                }};
            }
            return requireFromLib(name);
        }
    }, {filename});
    const influx = module.exports;
    await assert.rejects(influx.requestPowerOverPeriodMulti('24h', ['power1', 'power2']),
        error => error === failure);
    await assert.rejects(influx.requestPowerOverRange('2026-10-13', '2026-10-14', ['power1', 'power2']),
        error => error === failure);
});
