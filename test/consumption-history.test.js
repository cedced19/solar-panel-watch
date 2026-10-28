const assert = require('node:assert/strict');
const test = require('node:test');
const {createConsumptionHistory} = require('../lib/consumption-history');

const config = {victoria_default_tag: 'test-home'};
const at = seconds => Date.UTC(2026, 9, 13, 10, 0, seconds);
const iso = seconds => new Date(at(seconds)).toISOString();
const series = (name, points) => ({metric: {__name__: name, home: 'test-home'},
    timestamps: points.map(([seconds]) => at(seconds)), values: points.map(([, value]) => value)});
const READINGS = '{' + ['power_power1', 'power_power2', 'battery_socPercent', 'battery_packInputPower', 'battery_outputPackPower']
    .map(name => `__name__="${name}",home="test-home"`).join(' or ') + '}';

test('consumption query selects this home, sorts meters and assembles missing battery fields without zero filling', async () => {
    const calls = [];
    const api = createConsumptionHistory({config, client: {
        async exportSeries(selectors, start, stop, onSeries) {
            calls.push({selectors, start, stop});
            [
                series('power_power1', [[0, 400]]),
                series('power_power1', [[20, -100]]),
                series('power_power2', [[0, 800]]),
                series('battery_socPercent', [[0, 80], [20, 81]]),
                series('battery_packInputPower', [[20, 0]]),
                series('battery_outputPackPower', [[20, 300]])
            ].forEach(onSeries);
        }
    }});
    assert.deepEqual(await api.requestConsumptionOverPeriod('24h'), {
        power1: [{_time: iso(0), _value: 400}, {_time: iso(20), _value: -100}],
        power2: [{_time: iso(0), _value: 800}],
        battery: [{_time: iso(0), _value: 80},
            {_time: iso(20), _value: 81, packInputPower: 0, outputPackPower: 300}]
    });
    assert.equal(calls[0].selectors, READINGS);
    assert.equal(calls[0].stop - calls[0].start, 24 * 3600 * 1000);
});

test('aggregated consumption keeps a battery power field only in windows where it has as many samples as SOC', async () => {
    const queries = [];
    const api = createConsumptionHistory({config, client: {
        async queryWindows(query, start, stop, step) {
            queries.push({query, start, stop, step});
            if (query.startsWith('count_over_time')) {
                return [
                    series('battery_socPercent', [[0, 3], [60, 3]]),
                    series('battery_packInputPower', [[0, 3], [60, 2]]),
                    series('battery_outputPackPower', [[0, 3]])
                ];
            }
            return [
                series('power_power1', [[60, -50], [0, 100]]),
                series('battery_socPercent', [[0, 80], [60, 81]]),
                series('battery_packInputPower', [[0, 10], [60, 20]]),
                series('battery_outputPackPower', [[0, 5], [60, 6]])
            ];
        }
    }});
    assert.deepEqual(await api.requestConsumptionOverPeriod('2h', '5m'), {
        power1: [{_time: iso(0), _value: 100}, {_time: iso(60), _value: -50}],
        power2: [],
        battery: [{_time: iso(0), _value: 80, packInputPower: 10, outputPackPower: 5},
            {_time: iso(60), _value: 81}]
    });
    assert.deepEqual(queries.map(({query, step}) => [query, step]), [
        [`avg_over_time(${READINGS}[300000ms]) keep_metric_names`, 300000],
        ['count_over_time({' + ['socPercent', 'packInputPower', 'outputPackPower']
            .map(field => `__name__="battery_${field}",home="test-home"`).join(' or ') + '}[300000ms]) keep_metric_names', 300000]
    ]);
    assert.equal(queries[0].stop - queries[0].start, 2 * 3600 * 1000);
});

test('consumption queries propagate VictoriaMetrics errors', async () => {
    const failure = new Error('VictoriaMetrics unavailable');
    const api = createConsumptionHistory({config, client: {
        exportSeries: () => Promise.reject(failure),
        queryWindows: () => Promise.reject(failure)
    }});
    await assert.rejects(api.requestConsumptionOverPeriod('2h'), error => error === failure);
    await assert.rejects(api.requestConsumptionOverPeriod('2h', '1m'), error => error === failure);
    await assert.rejects(api.streamConsumptionOverRange(new Date(at(0)), new Date(at(20)), {}), error => error === failure);
    await assert.rejects(api.requestDevicePowerOverRange(new Date(at(0)), new Date(at(20)), ['heater']), error => error === failure);
});

// Series as the export sends them for each hour of the day stream.
function streamingClient(byHour) {
    const calls = [];
    return {calls, client: {
        async exportSeries(selectors, start, stop, onSeries) {
            calls.push({selectors, start, stop});
            (byHour[calls.length - 1] || []).forEach(onSeries);
        }
    }};
}

const streamHours = [[
    series('power_power1', [[0, 400], [10, -100]]),
    series('power_power2', [[0, 800]]),
    series('battery_packInputPower', [[10, 0]]),
    series('battery_socPercent', [[0, 80], [10, 81]]),
    series('battery_outputPackPower', [[10, 300]])
], [
    series('power_power1', [[3600, 200]])
]];

test('the day stream asks an hour at a time and feeds each reading to the sink in time order, without merging rows', async () => {
    const {calls, client} = streamingClient(streamHours);
    const api = createConsumptionHistory({config, client});
    const sink = {calls: [],
        addNetwork(...args) { this.calls.push(['network', ...args]); },
        addSolar(...args) { this.calls.push(['solar', ...args]); },
        addBattery(...args) { this.calls.push(['battery', ...args]); }
    };
    await api.streamConsumptionOverRange(new Date(at(0)), new Date(at(0) + 90 * 60000), sink);
    assert.deepEqual(sink.calls, [
        ['network', at(0), 400], ['network', at(10), -100], ['solar', at(0), 800],
        // A row without a power field passes it on as missing, never as zero.
        ['battery', at(0), undefined, undefined, 80], ['battery', at(10), 0, 300, 81],
        ['network', at(3600), 200]
    ]);
    assert.deepEqual(calls.map(({selectors, start, stop}) => [selectors, start, stop]), [
        [READINGS, at(0), at(3600)],
        [READINGS, at(3600), at(0) + 90 * 60000]
    ]);
});

test('streamed readings give the same energy as the arrays of the same readings', async () => {
    const computeEnergy = require('../lib/compute-energy');
    const api = createConsumptionHistory({config, client: streamingClient(streamHours).client});
    const accumulator = computeEnergy.createEnergyAccumulator();
    await api.streamConsumptionOverRange(new Date(at(0)), new Date(at(20)), accumulator);
    const points = (name) => streamHours[0].filter(s => s.metric.__name__ === name)
        .flatMap(s => s.timestamps.map((time, i) => ({_time: new Date(time).toISOString(), _value: s.values[i]})));
    const battery = [{_time: iso(0), _value: 80}, {_time: iso(10), _value: 81, packInputPower: 0, outputPackPower: 300}];
    const expected = computeEnergy(points('power_power1'), points('power_power2'), battery);
    assert.deepEqual(accumulator.result(), expected);
    // The first battery row has no power fields, so the day has no battery energy.
    assert.equal(expected[0].battery_charging, null);
    assert.equal(expected[0].solar_panel, 0.003);
    assert.equal(expected[0].battery_max_soc, 81);
});

test('device power over a range starts with the last value of the week before', async () => {
    const calls = [];
    const api = createConsumptionHistory({config, client: {
        async exportSeries(selectors, start, stop, onSeries) {
            calls.push({selectors, start, stop});
            onSeries(series('power_heater', [[-7200, 2000], [-3600, 0]]));
            onSeries(series('power_heater', [[0, 1500], [30, 0]]));
            onSeries(series('power_other', [[-60, 100]]));
        }
    }});
    assert.deepEqual(await api.requestDevicePowerOverRange(new Date(at(0)), new Date(at(60)), ['heater', 'idle', 'other']), {
        heater: [{_time: iso(-3600), _value: 0}, {_time: iso(0), _value: 1500}, {_time: iso(30), _value: 0}],
        idle: [],
        other: [{_time: iso(-60), _value: 100}]
    });
    assert.equal(calls[0].selectors, '{__name__="power_heater",home="test-home" or __name__="power_idle",home="test-home"' +
        ' or __name__="power_other",home="test-home"}');
    assert.deepEqual([calls[0].start, calls[0].stop], [at(0) - 7 * 24 * 3600 * 1000, at(60)]);
    assert.deepEqual(await api.requestDevicePowerOverRange(new Date(at(0)), new Date(at(60)), []), {});
    assert.equal(calls.length, 1);
});
