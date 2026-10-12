const assert = require('node:assert/strict');
const test = require('node:test');
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

test('battery history preserves the reading timestamp, percentage, and configured home', async () => {
    const {api, points, destinations, logs} = writer();
    const reading = {socPercent: 83.5, time: 1770000123, chargingPowerW: 220};
    await api.writeBatteryLevel(true, reading);
    // A cached poll writes the same point instead of inventing a new reading time.
    await api.writeBatteryLevel(false, reading);
    assert.deepEqual(destinations, [
        {org: 'test-org', bucket: 'test-bucket', tags: {home: 'test-home'}},
        {org: 'test-org', bucket: 'test-bucket', tags: {home: 'test-home'}}
    ]);
    const lines = points.map((point, index) => point.toLineProtocol({defaultTags: destinations[index].tags}));
    assert.deepEqual(lines, [
        'battery,home=test-home socPercent=83.5 1770000123000000000',
        'battery,home=test-home socPercent=83.5 1770000123000000000'
    ]);
    assert.deepEqual(logs, ['Battery level updated in InfluxDB.']);
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

test('battery query selects only this home and SOC, combines tables, and sorts history by time', async () => {
    let query;
    let queriedOrg;
    const history = createBatteryHistory({
        config,
        client: {
            getQueryApi(org) {
                queriedOrg = org;
                return {
                    queryRows(text, observer) {
                        query = text;
                        queueMicrotask(() => {
                            observer.next({_time: '2026-10-12T10:00:00Z', _value: 0, home: 'test-home'}, tableMeta);
                            observer.next({_time: '2026-10-12T10:00:20Z', _value: 1}, tableMeta);
                            observer.complete();
                        });
                    }
                };
            }
        }
    });
    const points = await history.requestBatteryLevelOverPeriod('24h');
    assert.equal(queriedOrg, 'test-org');
    assert.match(query, /from\(bucket: "test-bucket"\)/);
    assert.match(query, /range\(start: -24h\)/);
    assert.match(query, /r\["_measurement"\] == "battery"/);
    assert.match(query, /r\["_field"\] == "socPercent"/);
    assert.match(query, /r\["home"\] == "test-home"/);
    assert.match(query, /keep\(columns: \["_time", "_value"\]\)[\s\S]*group\(\)[\s\S]*sort\(columns: \["_time"\], desc: false\)/);
    assert.deepEqual(points, [
        {_time: '2026-10-12T10:00:00Z', _value: 0},
        {_time: '2026-10-12T10:00:20Z', _value: 1}
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

test('battery query rejects real Influx observer errors instead of returning partial history', async () => {
    const failure = new Error('Influx query failed');
    const history = createBatteryHistory({
        config,
        queryApi: {
            queryRows(query, observer) {
                queueMicrotask(() => {
                    observer.next({_time: '2026-10-12T10:00:00Z', _value: 80}, tableMeta);
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
