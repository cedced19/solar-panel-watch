const assert = require('node:assert/strict');
const test = require('node:test');
const {createFluxTableColumn, createFluxTableMetaData} = require('@influxdata/influxdb-client');
const {createBatteryHistory} = require('../lib/influx-lib');

const config = {
    influx_org: 'test-org',
    influx_bucket: 'test-bucket',
    influx_default_tag: 'test-home'
};

function writer(options = {}) {
    const points = [];
    const destinations = [];
    const logs = [];
    const errors = [];
    const api = createBatteryHistory({
        config,
        now: () => 1780000000123,
        client: {
            getWriteApi(org, bucket) {
                if (options.startError) throw options.startError;
                const destination = {org, bucket};
                destinations.push(destination);
                return {
                    useDefaultTags(tags) { destination.tags = tags; },
                    writePoint(point) { points.push(point); },
                    close() { return options.closeError ? Promise.reject(options.closeError) : Promise.resolve(); }
                };
            }
        },
        log(message) { logs.push(message); },
        logError(error) { errors.push(error); }
    });
    return {api, points, destinations, logs, errors};
}

test('battery history stores SOC and all four powers in one point with the reading timestamp and home', async () => {
    const {api, points, destinations, logs} = writer();
    const reading = {socPercent: 83.5, time: 1770000123, outputHomePowerW: 330,
        gridInputPowerW: 10, chargingPowerW: 220, dischargingPowerW: 40};
    await api.writeBatteryLevel(true, reading);
    // A cached poll writes the same point instead of inventing a new reading time.
    await api.writeBatteryLevel(false, reading);
    assert.deepEqual(destinations, [
        {org: 'test-org', bucket: 'test-bucket', tags: {home: 'test-home'}},
        {org: 'test-org', bucket: 'test-bucket', tags: {home: 'test-home'}}
    ]);
    const lines = points.map((point, index) => point.toLineProtocol({defaultTags: destinations[index].tags}));
    assert.deepEqual(lines, [
        'battery,home=test-home gridInputPower=10,outputHomePower=330,outputPackPower=220,packInputPower=40,socPercent=83.5 1770000123000000000',
        'battery,home=test-home gridInputPower=10,outputHomePower=330,outputPackPower=220,packInputPower=40,socPercent=83.5 1770000123000000000'
    ]);
    assert.deepEqual(logs, ['Battery level updated in InfluxDB.']);
});

test('battery power history preserves zero and omits missing or invalid optional readings', async () => {
    const {api, points} = writer();
    await api.writeBatteryLevel(false, {socPercent: 50, time: 1770000123, outputHomePowerW: 0,
        gridInputPowerW: 0, chargingPowerW: 0, dischargingPowerW: 0});
    assert.equal(points[0].toLineProtocol(),
        'battery gridInputPower=0,outputHomePower=0,outputPackPower=0,packInputPower=0,socPercent=50 1770000123000000000');

    const invalidValues = [undefined, null, '100', false, NaN, Infinity, -Infinity, -1];
    for (const invalid of invalidValues) {
        await api.writeBatteryLevel(false, {socPercent: 50, time: 1770000123, outputHomePowerW: invalid,
            gridInputPowerW: invalid, chargingPowerW: invalid, dischargingPowerW: invalid});
    }
    assert.equal(points.length, invalidValues.length + 1);
    assert.ok(points.slice(1).every((point) => point.toLineProtocol() ===
        'battery socPercent=50 1770000123000000000'));
});

test('zero percent is a valid reading, and absent timestamps alone use the local time', async () => {
    const {api, points} = writer();
    await api.writeBatteryLevel(false, {socPercent: 0, time: 0});
    await api.writeBatteryLevel(false, {socPercent: 100});
    const zeroPoint = points[0].toLineProtocol().split(' ');
    assert.deepEqual(zeroPoint.slice(0, 2), ['battery', 'socPercent=0']);
    assert.equal(BigInt(zeroPoint[2]), 0n);
    assert.equal(points[1].toLineProtocol(), 'battery socPercent=100 1780000000123000000');
});

test('unavailable or invalid levels and supplied invalid timestamps create no battery history', async () => {
    const {api, points, destinations} = writer();
    for (const battery of [null, undefined, {}, {socPercent: null}, {socPercent: '80'},
        {socPercent: NaN}, {socPercent: Infinity}, {socPercent: -1}, {socPercent: 100.1},
        {socPercent: 80, time: '1770000123'}, {socPercent: 80, time: NaN},
        {socPercent: 80, time: Infinity}, {socPercent: 80, time: Number.MAX_VALUE}]) {
        await api.writeBatteryLevel(false, battery);
    }
    assert.deepEqual(points, []);
    assert.deepEqual(destinations, []);
});

test('battery writer logs asynchronous and synchronous failures without rejecting callers', async () => {
    for (const mode of ['closeError', 'startError']) {
        const failure = new Error('InfluxDB unavailable');
        const {api, logs, errors} = writer({[mode]: failure});
        await assert.doesNotReject(api.writeBatteryLevel(false, {socPercent: 80, time: 1770000123}));
        assert.deepEqual(logs, ['Failed at updating battery level in InfluxDB.']);
        assert.deepEqual(errors, [failure]);
    }
});

const tableMeta = {
    column(name) {
        return {get(row) { return row[name]; }};
    }
};

test('battery query selects this home and all five fields in one query, pivots, and sorts history', async () => {
    let query;
    let queriedOrg;
    let queryCount = 0;
    const history = createBatteryHistory({
        config,
        client: {
            getQueryApi(org) {
                queriedOrg = org;
                return {
                    queryRows(text, observer) {
                        queryCount++;
                        query = text;
                        queueMicrotask(() => {
                            observer.next({_time: '2026-10-12T10:00:00Z', socPercent: 0, home: 'test-home'}, tableMeta);
                            observer.next({_time: '2026-10-12T10:00:20Z', socPercent: 1, outputHomePower: 250,
                                gridInputPower: 0, outputPackPower: 80, packInputPower: 0}, tableMeta);
                            observer.next({_time: '2026-10-12T10:00:40Z', socPercent: null,
                                outputHomePower: 100, gridInputPower: null}, tableMeta);
                            observer.complete();
                        });
                    }
                };
            }
        }
    });
    const points = await history.requestBatteryLevelOverPeriod('24h');
    assert.equal(queriedOrg, 'test-org');
    assert.equal(queryCount, 1);
    assert.match(query, /from\(bucket: "test-bucket"\)/);
    assert.match(query, /range\(start: -24h\)/);
    assert.match(query, /r\["_measurement"\] == "battery"/);
    assert.match(query, /r\["_field"\] == "socPercent"/);
    for (const field of ['outputHomePower', 'gridInputPower', 'outputPackPower', 'packInputPower']) {
        assert.ok(query.includes(`r["_field"] == "${field}"`));
    }
    assert.match(query, /r\["home"\] == "test-home"/);
    assert.match(query, /keep\(columns: \["_time", "_field", "_value"\]\)[\s\S]*group\(\)[\s\S]*pivot\(rowKey: \["_time"\], columnKey: \["_field"\], valueColumn: "_value"\)[\s\S]*sort\(columns: \["_time"\], desc: false\)/);
    assert.deepEqual(points, [
        {_time: '2026-10-12T10:00:00Z', _value: 0},
        {_time: '2026-10-12T10:00:20Z', _value: 1, outputHomePower: 250,
            gridInputPower: 0, outputPackPower: 80, packInputPower: 0},
        {_time: '2026-10-12T10:00:40Z', _value: null, outputHomePower: 100}
    ]);
});

test('battery query escapes configured bucket and home string literals', async () => {
    let query;
    const history = createBatteryHistory({
        config: {...config, influx_bucket: 'bucket"name', influx_default_tag: 'home\\name'},
        queryApi: {
            queryRows(text, observer) {
                query = text;
                observer.complete();
            }
        }
    });
    assert.deepEqual(await history.requestBatteryLevelOverPeriod('1h'), []);
    assert.ok(query.includes(String.raw`from(bucket: "bucket\"name")`));
    assert.ok(query.includes(String.raw`r["home"] == "home\\name"`));
});

test('battery history remains compatible with SOC-only tables without any power columns', async () => {
    const oldTable = createFluxTableMetaData([
        createFluxTableColumn({label: '_time', dataType: 'dateTime:RFC3339', index: 0}),
        createFluxTableColumn({label: 'socPercent', dataType: 'double', index: 1})
    ]);
    const history = createBatteryHistory({
        config,
        queryApi: {
            queryRows(query, observer) {
                observer.next(['2026-10-12T10:00:00Z', '80'], oldTable);
                observer.next(['2026-10-12T10:00:20Z', '0'], oldTable);
                observer.complete();
            }
        }
    });
    assert.deepEqual(await history.requestBatteryLevelOverPeriod('1h'), [
        {_time: '2026-10-12T10:00:00Z', _value: 80},
        {_time: '2026-10-12T10:00:20Z', _value: 0}
    ]);
});

test('battery query rejects real Influx observer errors instead of returning partial history', async () => {
    const failure = new Error('Influx query failed');
    const history = createBatteryHistory({
        config,
        queryApi: {
            queryRows(query, observer) {
                queueMicrotask(() => {
                    observer.next({_time: '2026-10-12T10:00:00Z', socPercent: 80}, tableMeta);
                    observer.error(failure);
                });
            }
        }
    });
    await assert.rejects(history.requestBatteryLevelOverPeriod('1h'), (error) => error === failure);
});

test('battery query propagates synchronous client failures', async () => {
    const failure = new Error('Invalid query configuration');
    const history = createBatteryHistory({
        config,
        client: {getQueryApi() { throw failure; }}
    });
    await assert.rejects(history.requestBatteryLevelOverPeriod('1h'), (error) => error === failure);
});
