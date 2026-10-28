// Runs the history against a real VictoriaMetrics when VICTORIA_TEST_URL is
// set (e.g. VICTORIA_TEST_URL=http://127.0.0.1:8428 npm test). It writes under
// a home label of its own and deletes those series afterwards.
const assert = require('node:assert/strict');
const test = require('node:test');
const {createVictoriaClient, selector} = require('../lib/victoria-client');
const {createSharedWriteApi, createPowerWriter, createBatteryHistory} = require('../lib/victoria-lib');
const {createConsumptionHistory} = require('../lib/consumption-history');

const url = process.env.VICTORIA_TEST_URL;
const minute = 60000;

test('readings written by the app come back raw, per window and streamed, as with InfluxDB', {
    skip: !url && 'set VICTORIA_TEST_URL to run against a real VictoriaMetrics'
}, async (t) => {
    const home = 'test-' + process.pid + '-' + Date.now();
    const config = {victoria_default_tag: home};
    const client = createVictoriaClient({url});
    t.after(() => fetch(url + '/api/v1/admin/tsdb/delete_series', {
        method: 'POST', body: new URLSearchParams({'match[]': `{home="${home}"}`})
    }));

    // Three minutes of readings, one per second from a whole hour two hours
    // ago: the grid every second, solar every other second, the battery
    // written twice per reading (cached polls) and its pack power every third.
    const base = Math.floor(Date.now() / (60 * minute)) * 60 * minute - 120 * minute;
    const writes = createSharedWriteApi({client, log() {}, logError: error => assert.fail(error)});
    let now = base;
    const power = createPowerWriter({config, writes, now: () => now});
    const battery = createBatteryHistory({config, writes, client});
    for (let i = 0; i < 180; i++) {
        now = base + i * 1000;
        await power.writePowerRaw(false, {emeters: [{power: i}, {power: i % 2 ? null : 1000}]});
        for (let copy = 0; copy < 2; copy++) {
            await battery.writeBatteryLevel(false, {socPercent: 50 + i / 10, time: now / 1000,
                ...(i % 3 ? {} : {dischargingPowerW: 300, chargingPowerW: 0})});
        }
    }
    await writes.flush();
    await fetch(url + '/internal/force_flush');

    const raw = [];
    await client.exportSeries(selector(['power_power1', 'battery_socPercent'], {home}), base, base + 180000,
        series => raw.push(series));
    const samples = name => raw.filter(series => series.metric.__name__ === name).flatMap(series => series.timestamps);
    assert.equal(samples('power_power1').length, 180);
    assert.equal(samples('battery_socPercent').length, 180, 'a reading written twice is kept once');

    // Means over [t - 1 min, t), stamped at t, like aggregateWindow.
    const windows = await client.queryWindows(`avg_over_time(${selector('power_power1', {home})}[${minute}ms])`,
        base, base + 180000, minute);
    assert.deepEqual(windows[0].timestamps, [base + minute, base + 2 * minute, base + 3 * minute]);
    assert.deepEqual(windows[0].values, [29.5, 89.5, 149.5]);

    // The consumption graph keeps pack power only where it has as many samples as SOC.
    const history = createConsumptionHistory({client, config});
    const graph = await history.requestConsumptionOverPeriod('3h', '1m');
    assert.deepEqual(graph.power1.map(point => point._value), [29.5, 89.5, 149.5]);
    assert.deepEqual(graph.power2.map(point => point._value), [1000, 1000, 1000]);
    assert.ok(graph.battery.length === 3 && graph.battery.every(row => !('packInputPower' in row)));
    const rawGraph = await history.requestConsumptionOverPeriod('3h');
    assert.equal(rawGraph.power1.length, 180);
    assert.equal(rawGraph.power2.length, 90);
    assert.equal(rawGraph.battery.filter(row => row.packInputPower === 300).length, 60);

    // The day stream feeds every reading once, in time order per meter.
    const fed = {network: [], solar: [], battery: []};
    await history.streamConsumptionOverRange(new Date(base - 30 * minute), new Date(base + 90 * minute), {
        addNetwork: (time, value) => fed.network.push([time, value]),
        addSolar: (time, value) => fed.solar.push([time, value]),
        addBattery: (time, discharging, charging, soc) => fed.battery.push([time, discharging, charging, soc])
    });
    assert.equal(fed.network.length, 180);
    assert.equal(fed.solar.length, 90);
    assert.equal(fed.battery.length, 180);
    for (const series of Object.values(fed)) {
        assert.ok(series.every((reading, i) => i === 0 || reading[0] > series[i - 1][0]));
    }
    assert.deepEqual(fed.battery[0], [base, 300, 0, 50]);
    assert.deepEqual(fed.battery[1], [base + 1000, undefined, undefined, 50.1]);

    // Device power: the last value before the range, then the range.
    const device = (time, value) => client.write([`power,home=${home} heater=${value} ${time}`]);
    await device(base - 3 * minute, 2000);
    await device(base - minute, 0);
    await device(base + minute, 1500);
    await fetch(url + '/internal/force_flush');
    const devicePower = await history.requestDevicePowerOverRange(new Date(base), new Date(base + 180000), ['heater']);
    assert.deepEqual(devicePower.heater.map(point => [Date.parse(point._time), point._value]),
        [[base - minute, 0], [base + minute, 1500]]);
});
