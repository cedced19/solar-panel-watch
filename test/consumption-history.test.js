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
    await assert.rejects(api.streamConsumptionOverRange(at(0), at(20), {}), error => error === failure);
});

// Rows as the streaming query returns them: one table per power field, then the battery rows pivoted by time.
const streamRows = [
    {result: 'power', _field: 'power1', _time: at(0), _value: 400},
    {result: 'power', _field: 'power1', _time: at(10), _value: -100},
    {result: 'power', _field: 'power2', _time: at(0), _value: 800},
    {result: 'battery', _time: at(0), socPercent: 80},
    {result: 'battery', _time: at(10), socPercent: 81, packInputPower: 0, outputPackPower: 300}
];

test('the day stream selects this home and feeds each reading to the sink in arrival order, without merging rows', async () => {
    let query;
    const api = createConsumptionHistory({config, queryApi: {
        queryRows(text, observer) {
            query = text;
            streamRows.forEach(row => observer.next(row, tableMeta));
            observer.complete();
        }
    }});
    const calls = [];
    const sink = {
        addNetwork: (...args) => calls.push(['network', ...args]),
        addSolar: (...args) => calls.push(['solar', ...args]),
        addBattery: (...args) => calls.push(['battery', ...args])
    };
    await api.streamConsumptionOverRange(new Date(at(0)), new Date(at(20)), sink);
    assert.deepEqual(calls, [
        ['network', at(0), 400], ['network', at(10), -100], ['solar', at(0), 800],
        // A row without a power field passes it on as missing, never as zero.
        ['battery', at(0), undefined, undefined, 80], ['battery', at(10), 0, 300, 81]
    ]);
    assert.ok(query.includes(`range(start: ${at(0)}, stop: ${at(20)})`));
    assert.match(query, /r\["home"\] == "test-home"/);
    assert.doesNotMatch(query, /aggregateWindow/);
    assert.match(query, /yield\(name: "power"\)/);
    assert.match(query, /pivot\(rowKey: \["_time"\], columnKey: \["_field"\], valueColumn: "_value"\)/);
    assert.equal(query.match(/sort\(columns: \["_time"\], desc: false\)/g).length, 2);
    for (const field of ['power1', 'power2', 'socPercent', 'packInputPower', 'outputPackPower']) {
        assert.ok(query.includes(`r["_field"] == "${field}"`), field);
    }
});

test('streamed readings give the same energy as the arrays of the same readings', async () => {
    const computeEnergy = require('../lib/compute-energy');
    const api = createConsumptionHistory({config, queryApi: {
        queryRows(text, observer) {
            streamRows.forEach(row => observer.next(row, tableMeta));
            observer.complete();
        }
    }});
    const accumulator = computeEnergy.createEnergyAccumulator();
    await api.streamConsumptionOverRange(new Date(at(0)), new Date(at(20)), accumulator);
    const series = field => streamRows.filter(row => row._field === field).map(({_time, _value}) => ({_time, _value}));
    const battery = streamRows.filter(row => row.result === 'battery').map(row => ({...row, _value: row.socPercent}));
    const expected = computeEnergy(series('power1'), series('power2'), battery);
    assert.deepEqual(accumulator.result(), expected);
    // The first battery row has no power fields, so the day has no battery energy.
    assert.equal(expected[0].battery_charging, null);
    assert.equal(expected[0].solar_panel, 0.003);
    assert.equal(expected[0].battery_max_soc, 81);
});
