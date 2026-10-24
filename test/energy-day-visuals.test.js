const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));

function load({reply = {ok: false, status: 500}, dataset = {}} = {}) {
    const nodes = new Map();
    const plots = new Map();
    const requests = [];
    function element() {
        return {children: [], style: {setProperty(key, value) { this[key] = value; }}, dataset: {}, hidden: false,
            textContent: '', innerHTML: '', attributes: {},
            appendChild(child) { this.children.push(child); },
            setAttribute(key, value) { this.attributes[key] = String(value); }};
    }
    const context = vm.createContext({
        window: {}, console: {error() {}},
        document: {
            createElement: element,
            createTextNode: text => ({textContent: String(text)}),
            getElementById(id) {
                if (!nodes.has(id)) nodes.set(id, element());
                return nodes.get(id);
            }
        },
        Plotly: {newPlot(id, traces, layout) { plots.set(id, {traces, layout}); }},
        fetch: async url => {
            requests.push(url);
            return {ok: reply.ok !== false, status: reply.status || 200, json: async () => reply.data};
        }
    });
    for (const file of ['energy-consumption.js', 'energy-day-visuals.js']) {
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../assets', file), 'utf8'), context, {filename: file});
    }
    Object.assign(context.document.getElementById('energy-day-visuals').dataset, {
        day: '2026-10-13', dayStart: '2026-10-12T22:00:00.000Z', timezone: 'Europe/Vienna',
        solar: 'Solar', grid: 'Grid', battery: 'Battery', house: 'Home', unavailable: 'Unavailable',
        profileError: 'Power history unavailable', profileEmpty: 'No power readings', ...dataset
    });
    return {visuals: context.window.energyDayVisuals, nodes, plots, requests};
}

const day = {
    day: '2026-10-13', complete: true, start_date: '2026-10-12T22:00:00.000Z', end_date: '2026-10-13T21:59:45.000Z',
    consumption_on_network: 4, introduced_on_network: -3, solar_panel: 10,
    battery_discharging: 2, battery_charging: 2.5, house_consumption: 10.5
};

test('day flows count export and battery charging as solar first and balance the household use', () => {
    const {visuals} = load();
    const flows = plain(visuals.dayFlows(day));
    assert.equal(flows.solarToGrid, 3);
    assert.equal(flows.solarToBattery, 2.5);
    assert.equal(flows.solarToHouse, 4.5);
    assert.equal(flows.batteryToHouse, 2);
    assert.equal(flows.gridToHouse, 4);
    assert.equal(flows.gridToBattery, 0);
    assert.equal(flows.solarToHouse + flows.batteryToHouse + flows.gridToHouse, day.house_consumption);
});

test('day flows send battery and grid surpluses where solar falls short', () => {
    const {visuals} = load();
    const flows = plain(visuals.dayFlows({...day, solar_panel: 1, introduced_on_network: -2,
        battery_charging: 3, consumption_on_network: 9, house_consumption: 9}));
    assert.equal(flows.solarToGrid, 1);
    assert.equal(flows.batteryToGrid, 1);
    assert.equal(flows.solarToBattery, 0);
    assert.equal(flows.gridToBattery, 3);
    assert.equal(flows.gridToHouse, 6);
    assert.equal(flows.batteryToHouse, 1);
});

test('day flows leave the battery out without both directions and need solar data', () => {
    const {visuals} = load();
    const flows = plain(visuals.dayFlows({...day, battery_charging: null, house_consumption: 11}));
    assert.equal(flows.battery, false);
    assert.equal(flows.solarToBattery, 0);
    assert.equal(flows.batteryToHouse, 0);
    assert.equal(visuals.dayFlows({...day, solar_panel: null}), null);
});

test('day ratios give self-sufficiency and self-consumption within 0 to 1', () => {
    const {visuals} = load();
    assert.deepEqual(plain(visuals.dayRatios(day)), {selfSufficiency: 6.5 / 10.5, selfConsumption: 0.7});
    assert.deepEqual(plain(visuals.dayRatios({...day, solar_panel: 0, house_consumption: 0})),
        {selfSufficiency: null, selfConsumption: null});
});

test('hourly energy integrates window averages into local hours and keeps empty hours null', () => {
    const {visuals} = load();
    const clock = visuals.zoneClock('Europe/Vienna');
    // Window ends in UTC; 08:05Z is 10:05 in Vienna and covers 10:00-10:05.
    const series = values => values.map(([time, value]) => ({_time: time, _value: value}));
    const balance = {
        power1: series([['2026-10-13T08:05:00Z', 1200], ['2026-10-13T08:10:00Z', -600]]),
        power2: series([['2026-10-13T08:05:00Z', 2400]]),
        battery_discharging: series([['2026-10-13T08:05:00Z', 0]]),
        battery_charging: series([['2026-10-13T08:05:00Z', 600]]),
        house_consumption: series([['2026-10-12T22:00:00Z', 300], ['2026-10-13T08:05:00Z', 3000]])
    };
    const hourly = plain(visuals.hourlyEnergy(balance, '2026-10-13', clock, 5 * 60 * 1000));
    assert.equal(hourly.gridImport[10], 0.1);
    assert.equal(hourly.gridExport[10], -0.05);
    assert.equal(hourly.solar[10], 0.2);
    assert.equal(hourly.charging[10], -0.05);
    assert.equal(hourly.house[10], 0.25);
    // 22:00Z closes the 23:55-00:00 window of the previous local day.
    assert.equal(hourly.house[23], null);
    assert.equal(hourly.solar[9], null);
});

test('rendering a day draws gauges, tiles, flow and donuts, then loads the power since midnight', async () => {
    const minute = time => ({_time: time, _value: 500});
    const {visuals, nodes, plots, requests} = load({reply: {data: {
        power1: [minute('2026-10-13T08:05:00Z')], power2: [minute('2026-10-13T08:05:00Z')],
        battery_discharging: [minute('2026-10-13T08:05:00Z')], battery_charging: [minute('2026-10-13T08:05:00Z')],
        house_consumption: [minute('2026-10-13T08:05:00Z')]
    }}});
    await visuals.render(day);
    await settle();
    assert.match(requests[0], /^\/api\/data\/consumption\/\d+m\?every=5m$/);
    assert.equal(nodes.get('energy-rings').children.length, 2);
    assert.equal(nodes.get('energy-tiles').children.length, 6);
    assert.deepEqual([...plots.keys()],
        ['energy-flow', 'energy-house-sources', 'energy-solar-uses', 'energy-profile', 'energy-hourly']);
    const flow = plots.get('energy-flow').traces[0];
    assert.equal(flow.type, 'sankey');
    assert.equal(flow.link.value.reduce((sum, value) => sum + value, 0), 4.5 + 2.5 + 3 + 2 + 4);
    assert.deepEqual(plain(plots.get('energy-house-sources').traces[0].values), [4.5, 2, 4]);
    assert.deepEqual(plain(plots.get('energy-profile').layout.xaxis.range), ['2026-10-13T00:00:00', '2026-10-14T00:00:00']);
    assert.equal(nodes.get('energy-profile-status').hidden, true);
});

test('a day without data or power history hides the charts and reports the failure', async () => {
    const {visuals, nodes, plots} = load();
    await visuals.render({day: '2026-10-13', start_date: null});
    assert.equal(nodes.get('energy-glance-card').hidden, true);
    assert.equal(nodes.get('energy-flow-card').hidden, true);
    assert.equal(nodes.get('energy-hourly-card').hidden, true);
    assert.equal(nodes.get('energy-profile-status').textContent, 'Power history unavailable');
    assert.equal(plots.size, 0);
});

test('a container without intraday charts draws only the day totals and never requests the power history', async () => {
    const {visuals, nodes, plots, requests} = load({dataset: {intraday: 'false'}});
    await visuals.render(day);
    assert.deepEqual(requests, []);
    assert.deepEqual([...plots.keys()], ['energy-flow', 'energy-house-sources', 'energy-solar-uses']);
    assert.equal(nodes.get('energy-tiles').children.length, 6);
    assert.equal(nodes.get('energy-day-visuals').hidden, false);
    assert.equal(nodes.has('energy-profile-status'), false);
});
