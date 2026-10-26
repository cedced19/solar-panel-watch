const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));

function load({reply = {ok: false, status: 500}, dataset = {}, storage} = {}) {
    const nodes = new Map();
    const plots = new Map();
    const requests = [];
    function element() {
        return {children: [], style: {setProperty(key, value) { this[key] = value; }}, dataset: {}, hidden: false,
            textContent: '', innerHTML: '', attributes: {}, listeners: {},
            addEventListener(type, listener) { (this.listeners[type] = this.listeners[type] || []).push(listener); },
            appendChild(child) { this.children.push(child); },
            setAttribute(key, value) { this.attributes[key] = String(value); }};
    }
    const context = vm.createContext({
        window: storage ? {localStorage: storage} : {}, console: {error() {}},
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
    assert.deepEqual(plain(visuals.dayRatios(day)), {selfSufficiency: 6.5 / 10.5, selfConsumption: 0.7, batteryPeak: null});
    assert.deepEqual(plain(visuals.dayRatios({...day, solar_panel: 0, house_consumption: 0})),
        {selfSufficiency: null, selfConsumption: null, batteryPeak: null});
});

test('the battery peak ratio is the highest level of the day as a share of 1, and null when not stored', () => {
    const {visuals} = load();
    assert.equal(visuals.dayRatios({...day, battery_max_soc: 87.5}).batteryPeak, 0.875);
    assert.equal(visuals.dayRatios({...day, battery_max_soc: 0}).batteryPeak, 0);
    assert.equal(visuals.dayRatios({...day, battery_max_soc: 130}).batteryPeak, 1);
    for (const value of [null, undefined, NaN, '87']) {
        assert.equal(visuals.dayRatios({...day, battery_max_soc: value}).batteryPeak, null, String(value));
    }
});

test('the battery peak is drawn as a third gauge in the battery colour, unavailable without a stored level', async () => {
    const dataset = {batteryPeak: 'Battery peak level', batteryPeakHint: 'Highest battery level of the day'};
    const rings = async entry => {
        const {visuals, nodes} = load({dataset});
        await visuals.render(entry);
        return nodes.get('energy-rings').children;
    };
    const [, , peak] = await rings({...day, battery_max_soc: 87.5});
    assert.equal(peak.children[0].style['--ring-value'], 0.875);
    assert.equal(peak.children[0].style['--ring-color'], '#8e44ad');
    assert.equal(peak.children[0].attributes['aria-label'], 'Battery peak level: 88%');
    assert.equal(peak.children[0].children[0].children[0].textContent, '88%');
    assert.deepEqual(peak.children[1].children.map(child => child.textContent),
        ['Battery peak level', 'Highest battery level of the day']);
    const [, , missing] = await rings(day);
    assert.match(missing.children[0].className, /is-unavailable/);
    assert.equal(missing.children[0].attributes['aria-label'], 'Battery peak level: Unavailable');
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
    assert.equal(nodes.get('energy-rings').children.length, 3);
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

test('battery charging at night comes from the grid in the flows, and is ignored when unknown', () => {
    const {visuals} = load();
    const flows = plain(visuals.dayFlows({...day, charging_energy_from_network: 1.5}));
    assert.equal(flows.gridToBattery, 1.5);
    assert.equal(flows.solarToBattery, 1);
    assert.equal(flows.solarToHouse, 6);
    assert.equal(flows.gridToHouse, 2.5);
    assert.equal(flows.solarToHouse + flows.batteryToHouse + flows.gridToHouse, day.house_consumption);
    for (const value of [null, undefined, -1]) {
        assert.deepEqual(plain(visuals.dayFlows({...day, charging_energy_from_network: value})),
            plain(visuals.dayFlows(day)), String(value));
    }
    // Never more than the battery charging or the grid import.
    const capped = plain(visuals.dayFlows({...day, charging_energy_from_network: 9}));
    assert.equal(capped.gridToBattery, 2.5);
    assert.equal(capped.solarToBattery, 0);
});

test('the battery charge tile notes the charging from the grid at night when there is some', async () => {
    const dataset = {intraday: 'false', fromGridAtNight: 'from the grid at night'};
    const {visuals, nodes} = load({dataset});
    await visuals.render({...day, charging_energy_from_network: 1.5});
    const charging = nodes.get('energy-tiles').children[5];
    assert.equal(charging.children.at(-1).textContent, '1.50 kWh from the grid at night');
    for (const value of [0, null]) {
        const {visuals: other, nodes: otherNodes} = load({dataset});
        await other.render({...day, charging_energy_from_network: value});
        assert.equal(otherNodes.get('energy-tiles').children[5].children.length, 2, String(value));
    }
});

test('the household use splits into the devices and the rest in the flows, only when the devices are known', async () => {
    const dataset = {intraday: 'false', devices: 'Devices', otherHouse: 'Other household use'};
    const {visuals, plots} = load({dataset});
    const flows = plain(visuals.dayFlows({...day, devices_consumption: 3}));
    assert.deepEqual([flows.houseToDevices, flows.houseToOther], [3, 7.5]);
    assert.equal(plain(visuals.dayFlows({...day, devices_consumption: 20})).houseToDevices, 10.5,
        'never more than the household use');
    for (const value of [null, undefined, -1]) {
        assert.equal(plain(visuals.dayFlows({...day, devices_consumption: value})).houseToDevices, 0, String(value));
    }

    await visuals.render({...day, devices_consumption: 3});
    const flow = plots.get('energy-flow').traces[0];
    const labels = Array.from(flow.node.label);
    const house = labels.findIndex(label => label.startsWith('Home'));
    const fromHouse = Array.from(flow.link.source).flatMap((source, i) => source === house ?
        [labels[flow.link.target[i]] + ' ' + flow.link.value[i]] : []);
    assert.deepEqual(fromHouse, ['Devices · 3.00 kWh 3', 'Other household use · 7.50 kWh 7.5']);

    const {visuals: without, plots: withoutPlots} = load({dataset});
    await without.render(day);
    const asBefore = withoutPlots.get('energy-flow').traces[0];
    assert.ok(!Array.from(asBefore.node.label).some(label => label.startsWith('Devices')));
    assert.equal(asBefore.link.value.length, 5, 'the diagram is as before');
});

test('the energy flow button hides and shows the activated devices and remembers the choice', async () => {
    const saved = new Map();
    const storage = {getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value)};
    const dataset = {intraday: 'false', devices: 'Activated device', otherHouse: 'Other household use',
        hideDevices: 'Hide activated devices', showDevices: 'Show activated devices'};
    const deviceNodes = plots => Array.from(plots.get('energy-flow').traces[0].node.label)
        .filter(label => /^(Activated device|Other household use)/.test(label)).length;

    const {visuals, nodes, plots} = load({dataset, storage});
    await visuals.render({...day, devices_consumption: 3});
    const toggle = nodes.get('energy-devices-toggle');
    assert.equal(toggle.hidden, false);
    assert.equal(toggle.textContent, 'Hide activated devices');
    assert.equal(deviceNodes(plots), 2);

    toggle.listeners.click[0]();
    assert.equal(deviceNodes(plots), 0, 'the household use is no longer split');
    assert.equal(plots.get('energy-flow').traces[0].link.value.length, 5);
    assert.equal(toggle.textContent, 'Show activated devices');
    assert.equal(saved.get('energy-flow-devices'), 'hidden');
    assert.equal(toggle.listeners.click.length, 1, 'the button is wired once');

    // The next day drawn, and the next page, keep the choice.
    await visuals.render({...day, devices_consumption: 2});
    assert.equal(deviceNodes(plots), 0);
    const {visuals: next, plots: nextPlots} = load({dataset, storage});
    await next.render({...day, devices_consumption: 3});
    assert.equal(deviceNodes(nextPlots), 0);

    toggle.listeners.click[0]();
    assert.equal(deviceNodes(plots), 2);
    assert.equal(saved.get('energy-flow-devices'), 'shown');

    // A day without activated devices has nothing to hide.
    await visuals.render(day);
    assert.equal(toggle.hidden, true);
});

test('the solar energy donut gives the activated devices their share of the solar, solar first', async () => {
    const {visuals, nodes, plots} = load({dataset: {intraday: 'false', devices: 'Activated device',
        otherHouse: 'Other household use', hideDevices: 'Hide', showDevices: 'Show'}});
    // 4.5 kWh of solar reach the household: the devices take 3 of them, at most all of them.
    assert.equal(plain(visuals.dayFlows({...day, devices_consumption: 3})).solarToDevices, 3);
    assert.equal(plain(visuals.dayFlows({...day, devices_consumption: 6})).solarToDevices, 4.5);
    assert.equal(plain(visuals.dayFlows(day)).solarToDevices, 0);

    const slices = () => {
        const trace = plots.get('energy-solar-uses').traces[0];
        return Array.from(trace.labels).map((label, i) => label + ' ' + trace.values[i]);
    };
    await visuals.render({...day, devices_consumption: 3});
    assert.deepEqual(slices(), ['Other household use 1.5', 'Activated device 3', 'Battery 2.5', 'Grid 3']);
    assert.equal(nodes.get('energy-solar-uses-note').hidden, false);

    nodes.get('energy-devices-toggle').listeners.click[0]();
    assert.deepEqual(slices(), ['Home 4.5', 'Battery 2.5', 'Grid 3'], 'hidden like in the energy flow');
    assert.equal(nodes.get('energy-solar-uses-note').hidden, true);
    nodes.get('energy-devices-toggle').listeners.click[0]();
    assert.equal(slices().length, 4);

    await visuals.render(day);
    assert.deepEqual(slices(), ['Home 4.5', 'Battery 2.5', 'Grid 3']);
    assert.equal(nodes.get('energy-solar-uses-note').hidden, true);
});
