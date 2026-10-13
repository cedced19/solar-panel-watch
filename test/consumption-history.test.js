const assert = require('node:assert/strict');
const test = require('node:test');
const {createConsumptionHistory} = require('../lib/consumption-history');

const config = {influx_bucket: 'test-bucket', influx_default_tag: 'test-home'};
const tableMeta = {column: name => ({get: row => row[name]})};
const at = seconds => new Date(Date.UTC(2026, 9, 13, 10, 0, seconds)).toISOString();

test('consumption query selects this home, sorts meters and assembles missing battery fields without zero filling', async () => {
    let query;
    const rows = [
        {_time: at(20), _field: 'power1', _value: -100},
        {_time: at(0), _field: 'power1', _value: 400},
        {_time: at(0), _field: 'power2', _value: 800},
        {_time: at(0), _field: 'socPercent', _value: 80},
        {_time: at(20), _field: 'packInputPower', _value: 0},
        {_time: at(20), _field: 'outputPackPower', _value: 300},
        {_time: at(20), _field: 'socPercent', _value: 81}
    ];
    const api = createConsumptionHistory({config, queryApi: {
        queryRows(text, observer) {
            query = text;
            rows.forEach(row => observer.next(row, tableMeta));
            observer.complete();
        }
    }});
    assert.deepEqual(await api.requestConsumptionOverPeriod('24h'), {
        power1: [{_time: at(0), _value: 400}, {_time: at(20), _value: -100}],
        power2: [{_time: at(0), _value: 800}],
        battery: [{_time: at(0), _value: 80},
            {_time: at(20), _value: 81, packInputPower: 0, outputPackPower: 300}]
    });
    assert.match(query, /range\(start: -24h\)/);
    assert.match(query, /r\["home"\] == "test-home"/);
    for (const field of ['power1', 'power2', 'socPercent', 'packInputPower', 'outputPackPower']) {
        assert.ok(query.includes(`r["_field"] == "${field}"`));
    }
    assert.doesNotMatch(query, /aggregateWindow/);
    await api.requestConsumptionOverPeriod('24h', '5m');
    assert.match(query, /aggregateWindow\(every: 5m, fn: mean, createEmpty: false\)/);
    await api.requestConsumptionOverRange(at(0), at(20));
    assert.ok(query.includes(`range(start: ${at(0)}, stop: ${at(20)})`));
    assert.doesNotMatch(query, /aggregateWindow/);
});

test('consumption queries escape configured literals and propagate Influx errors', async () => {
    let query;
    const failure = new Error('Influx unavailable');
    const api = createConsumptionHistory({
        config: {influx_bucket: 'bucket"name', influx_default_tag: 'home\\name'},
        queryApi: {queryRows(text, observer) {
            query = text;
            queueMicrotask(() => observer.error(failure));
        }}
    });
    await assert.rejects(api.requestConsumptionOverPeriod('2h'), error => error === failure);
    assert.ok(query.includes(String.raw`from(bucket: "bucket\"name")`));
    assert.ok(query.includes(String.raw`r["home"] == "home\\name"`));
    await assert.rejects(api.requestConsumptionOverRange(at(0), at(20)), error => error === failure);
});

test('aggregated battery means preserve unavailable windows and complete measured zeros', async () => {
    const rows = [];
    for (const seconds of [0, 60]) {
        for (const [field, value] of [['socPercent', 80], ['packInputPower', 0], ['outputPackPower', 300]]) {
            rows.push({_time: at(seconds), _field: field, _value: value, result: 'mean'});
            rows.push({_time: at(seconds), _field: field,
                _value: seconds === 0 && field === 'outputPackPower' ? 1 : 2, result: 'battery_counts'});
        }
    }
    const api = createConsumptionHistory({config, queryApi: {queryRows(query, observer) {
        assert.match(query, /aggregateWindow\(every: 1m, fn: count, createEmpty: false\)/);
        rows.forEach(row => observer.next(row, tableMeta));
        observer.complete();
    }}});
    const data = await api.requestConsumptionOverPeriod('24h', '1m');
    assert.deepEqual(data.battery, [
        {_time: at(0), _value: 80, packInputPower: 0},
        {_time: at(60), _value: 80, packInputPower: 0, outputPackPower: 300}
    ]);
});
