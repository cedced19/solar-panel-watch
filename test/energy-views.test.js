const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ejs = require('ejs');

function page(name, data) {
    const filename = path.resolve(__dirname, '../views', name + '.ejs');
    const html = ejs.render(fs.readFileSync(filename, 'utf8'), {
        __: label => label, period: '24h', timezone: 'Europe/Vienna', config: {}
    }, {filename});
    const nodes = new Map();
    const cells = [];
    const plots = new Map();
    function element(tag) {
        const node = {children: [], style: {}, textContent: '', value: '', checked: false,
            appendChild(child) { this.children.push(child); }, addEventListener() {},
            closest() { return {offsetWidth: 1000}; }};
        if (tag === 'td') cells.push(node);
        return node;
    }
    const context = vm.createContext({
        document: {
            createElement: element,
            createTextNode: text => ({textContent: String(text)}),
            getElementById(id) {
                if (!nodes.has(id)) nodes.set(id, element());
                return nodes.get(id);
            }
        },
        window: {addEventListener() {}, innerWidth: 1200}, console,
        Plotly: {newPlot(id, traces, layout) { plots.set(id, {traces, layout}); }},
        fetch: async () => ({json: async () => data})
    });
    for (const script of html.matchAll(/<script(?: src="([^"]+)")?>([\s\S]*?)<\/script>/g)) {
        if (script[1] === '/assets/energy-consumption.js') {
            vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..' + script[1]), 'utf8'), context,
                {filename: script[1]});
        } else if (!script[1]) {
            vm.runInContext(script[2], context);
        }
    }
    return {context, cells, nodes, plots};
}

async function renderTable(name, rows) {
    const data = name === 'energy-request-hist' ?
        [{date: rows[0].start_date, period: '2026-10-13', result: rows}] : rows;
    const result = page(name, data);
    if (name === 'energy-calendar') {
        result.context.energyData = rows;
        vm.runInContext('renderDay("2026-10-13", energyData)', result.context);
    } else {
        vm.runInContext('loadData()', result.context);
        await new Promise(resolve => setImmediate(resolve));
    }
    return result.cells.map(cell => cell.children.length ?
        cell.children.map(child => child.textContent).join('') : String(cell.textContent));
}

const day = {
    start_date: '2026-10-13T10:00:00.000Z', end_date: '2026-10-13T10:01:00.000Z',
    consumption_on_network: 0.012, introduced_on_network: 0,
    solar_panel: null, house_consumption: null
};

for (const name of ['energy-calendar', 'energy', 'energy-request-hist']) {
    test(`${name} displays unavailable solar, house and savings while retaining grid totals`, async () => {
        const text = await renderTable(name, [day]);
        assert.deepEqual(text.slice(2), ['0.012', 'Unavailable', 'Unavailable',
            'Unavailable', 'Unavailable', '0', 'Unavailable']);
    });

    test(`${name} shows battery energy and uses house consumption for totals and savings`, async () => {
        const text = await renderTable(name, [{...day, consumption_on_network: 2, solar_panel: 6,
            battery_discharging: 4, battery_charging: 3, introduced_on_network: -1, house_consumption: 8}]);
        assert.deepEqual(text.slice(2), name === 'energy-calendar' ?
            ['2', '6', '4', '3', '8', '-1', '6'] :
            ['2 (25%)', '6', '4', '3', '8', '-1', '6 (75%)']);
    });

    test(`${name} preserves recorded legacy totals without inventing battery energy`, async () => {
        const text = await renderTable(name, [{...day, solar_panel: 0.013, house_consumption: 0.025}]);
        assert.equal(text[3], '0.013');
        assert.deepEqual(text.slice(4, 7), ['Unavailable', 'Unavailable', '0.025']);
    });

    test(`${name} recovers old unavailable totals and savings without battery history`, async () => {
        const text = await renderTable(name, [{...day, consumption_on_network: 2,
            introduced_on_network: -1, solar_panel: 6,
            battery_discharging: null, battery_charging: null}]);
        assert.deepEqual(text.slice(2), name === 'energy-calendar' ?
            ['2', '6', 'Unavailable', 'Unavailable', '7', '-1', '5'] :
            ['2 (28%)', '6', 'Unavailable', 'Unavailable', '7', '-1', '5 (71%)']);
    });

    test(`${name} ignores both battery adjustments when either direction is missing`, async () => {
        for (const unavailable of ['battery_discharging', 'battery_charging']) {
            const row = {...day, consumption_on_network: 2, introduced_on_network: -1,
                solar_panel: 6, battery_discharging: 4, battery_charging: 3};
            delete row[unavailable];
            const text = await renderTable(name, [row]);
            assert.equal(text[6], '7');
            assert.equal(text[8], name === 'energy-calendar' ? '5' : '5 (71%)');
        }
    });

    test(`${name} preserves the published decimal precision of totals and savings`, async () => {
        const text = await renderTable(name, [{...day, solar_panel: 0.025,
            battery_discharging: null, battery_charging: null}]);
        assert.equal(text[6], '0.037');
        assert.equal(text[8], name === 'energy-calendar' ? '0.025' : '0.025 (67%)');
    });

    test(`${name} ignores invalid negative battery data without replacing recorded totals`, async () => {
        for (const invalid of ['battery_discharging', 'battery_charging']) {
            const row = {...day, consumption_on_network: 2, introduced_on_network: -1,
                solar_panel: 6, battery_discharging: 4, battery_charging: 3, [invalid]: -1};
            const text = await renderTable(name, [row]);
            assert.equal(text[6], '7');
            const recorded = await renderTable(name, [{...row, house_consumption: 5}]);
            assert.equal(recorded[6], '5');
        }
    });

    test(`${name} retains unavailable totals when required grid or solar data is missing`, async () => {
        for (const unavailable of ['consumption_on_network', 'introduced_on_network', 'solar_panel']) {
            const row = {...day, consumption_on_network: 2, introduced_on_network: -1, solar_panel: 6};
            delete row[unavailable];
            const text = await renderTable(name, [row]);
            assert.equal(text[6], 'Unavailable');
            assert.equal(text[8], 'Unavailable');
        }
        const text = await renderTable(name, [{...day, solar_panel: 6,
            battery_discharging: 4, battery_charging: 3}]);
        assert.equal(text[6], 'Unavailable', 'complete battery data does not repair an unrelated missing total');
    });

    test(`${name} handles missing fields and zero consumption without invalid percentages`, async () => {
        const missing = {...day};
        delete missing.solar_panel;
        delete missing.house_consumption;
        const text = await renderTable(name, [missing]);
        assert.deepEqual(text.slice(3, 7), ['Unavailable', 'Unavailable', 'Unavailable', 'Unavailable']);
        const zero = await renderTable(name, [{...day, consumption_on_network: 0, solar_panel: 0,
            battery_discharging: 0, battery_charging: 0, house_consumption: 0}]);
        assert.deepEqual(zero.slice(2), ['0', '0', '0', '0', '0', '0', '0']);
        const withoutBattery = await renderTable(name, [{...day, consumption_on_network: 0,
            solar_panel: 0, battery_discharging: null, battery_charging: null}]);
        assert.deepEqual(withoutBattery.slice(2), ['0', '0', 'Unavailable', 'Unavailable', '0', '0', '0']);
    });
}

test('history graphs preserve unavailable dependent totals through aggregation and moving averages', () => {
    const {context} = page('energy-graph');
    const validDay = {...day, start_date: '2026-10-14T10:00:00.000Z',
        house_consumption: 0.025, solar_panel: 0.013};
    context.entries = [day, validDay];
    vm.runInContext('rawFlattenedData = entries', context);
    for (const aggregation of ['day', 'month', 'year']) {
        const result = JSON.parse(JSON.stringify(vm.runInContext(`aggregateData('${aggregation}')`, context)));
        assert.equal(result.solar[0], null);
        assert.equal(result.batteryDischarging[0], null);
        assert.equal(result.batteryCharging[0], null);
        assert.equal(result.saved[0], null);
        assert.equal(result.totalEnergyUsed[0], null);
        assert.equal(result.consumption[0], aggregation === 'day' ? 0.012 : 0.024);
    }
    assert.equal(vm.runInContext('calculateMovingAverage([null, 1, 2], 3)[0]', context), null);
    assert.equal(vm.runInContext('calculateMovingAverage([undefined, 1, 2], 3)[0]', context), null);
});

test('energy graphs aggregate recorded battery-aware house totals and show charging as an outflow', () => {
    const {context, plots} = page('energy-graph');
    const validDay = {...day, consumption_on_network: 2, solar_panel: 6,
        battery_discharging: 4, battery_charging: 3, introduced_on_network: -1, house_consumption: 8};
    context.entries = [validDay, {...validDay, start_date: '2026-10-14T10:00:00.000Z'}];
    vm.runInContext("rawFlattenedData = entries; updateAllGraphs('month')", context);
    const total = plots.get('graph-total').traces[0];
    assert.deepEqual(Array.from(total.y), [16]);
    assert.deepEqual(Array.from(plots.get('graph-battery-discharging').traces[0].y), [8]);
    assert.deepEqual(Array.from(plots.get('graph-battery-charging').traces[0].y), [6]);
    const stack = plots.get('graph-stacked').traces;
    assert.deepEqual(Array.from(stack, trace => Array.from(trace.y)), [[4], [12], [-2], [8], [-6], [16]]);
    assert.equal(stack[5].type, 'scatter');
});

test('energy breakdown tables and graphs retain gaps for missing legacy battery data', () => {
    const {context, cells, plots} = page('energy-graph');
    context.entries = [{...day, solar_panel: 0.013, house_consumption: 0.025}];
    vm.runInContext("rawFlattenedData = entries; updateAllGraphs('year'); renderBreakdownTable()", context);
    const stack = plots.get('graph-stacked').traces;
    assert.deepEqual(Array.from(stack[3].y), [null]);
    assert.deepEqual(Array.from(stack[4].y), [null]);
    assert.deepEqual(Array.from(stack[5].y), [0.025]);
    assert.deepEqual(cells.map(cell => String(cell.textContent)),
        ['2026', '0.012', '0.013', 'Unavailable', 'Unavailable', '0.025', '0']);
});

test('history graph totals, savings and breakdown recover stored null totals for all period aggregations', () => {
    const {context, cells, plots} = page('energy-graph');
    const withoutBattery = {...day, consumption_on_network: 2, introduced_on_network: -1,
        solar_panel: 6, battery_discharging: null, battery_charging: null};
    const partialBattery = {...withoutBattery, start_date: '2026-10-14T10:00:00.000Z',
        battery_discharging: 4};
    context.entries = [withoutBattery, partialBattery];
    vm.runInContext('rawFlattenedData = entries', context);
    for (const aggregation of ['day', 'week', 'month', 'year']) {
        const result = JSON.parse(JSON.stringify(vm.runInContext(`aggregateData('${aggregation}')`, context)));
        assert.deepEqual(result.totalEnergyUsed, aggregation === 'day' ? [7, 7] : [14]);
        assert.deepEqual(result.saved, aggregation === 'day' ? [5, 5] : [10]);
        assert.equal(result.batteryDischarging[0], null);
        assert.equal(result.batteryCharging[0], null);
    }
    vm.runInContext("updateAllGraphs('year'); renderBreakdownTable()", context);
    assert.deepEqual(Array.from(plots.get('graph-total').traces[0].y), [14]);
    assert.deepEqual(Array.from(plots.get('graph-saved').traces[0].y), [10]);
    assert.deepEqual(Array.from(plots.get('graph-stacked').traces[5].y), [14]);
    assert.deepEqual(cells.map(cell => String(cell.textContent)),
        ['2026', '4', '12', 'Unavailable', 'Unavailable', '14', '-2']);
    assert.equal(context.entries[0].house_consumption, null, 'saved entries are not rewritten');
    assert.equal(context.entries[1].house_consumption, null);
});

test('stored fallback sums published kWh without losing a decimal place to floating point', () => {
    const {context} = page('energy-graph');
    context.entries = [{...day, consumption_on_network: 0.1, introduced_on_network: -0.2, solar_panel: 0.4}];
    vm.runInContext('rawFlattenedData = entries', context);
    const result = JSON.parse(JSON.stringify(vm.runInContext("aggregateData('day')", context)));
    assert.deepEqual(result.totalEnergyUsed, [0.3]);
});

test('mixed fallback and battery-aware periods retain decimal precision in graphs and breakdown', () => {
    const {context, cells, plots} = page('energy-graph');
    context.entries = [
        {...day, solar_panel: 0.025, battery_discharging: null, battery_charging: null},
        {...day, start_date: '2026-10-14T10:00:00.000Z', consumption_on_network: 0.007,
            solar_panel: 0.01, battery_discharging: 0.002, battery_charging: 0.004, house_consumption: 0.015}
    ];
    vm.runInContext("rawFlattenedData = entries; updateAllGraphs('month'); renderBreakdownTable()", context);
    assert.deepEqual(Array.from(plots.get('graph-total').traces[0].y), [0.052]);
    assert.deepEqual(Array.from(plots.get('graph-saved').traces[0].y), [0.033]);
    assert.deepEqual(cells.map(cell => String(cell.textContent)),
        ['2026', '0.019', '0.035', 'Unavailable', 'Unavailable', '0.052', '0']);
});

test('mixed daily history prefers battery-aware calculations over larger legacy totals', () => {
    const {context} = page('energy-graph');
    const legacy = {...day, consumption_on_network: 2, solar_panel: 6, house_consumption: 8};
    const updated = {...legacy, start_date: '2026-10-13T14:00:00.000Z',
        battery_discharging: 0, battery_charging: 3, house_consumption: 5};
    context.entries = [legacy, updated];
    vm.runInContext('rawFlattenedData = preferBatteryAwareCalculations(entries)', context);
    assert.equal(vm.runInContext('rawFlattenedData.length', context), 1);
    const result = JSON.parse(JSON.stringify(vm.runInContext("aggregateData('day')", context)));
    assert.deepEqual(result.totalEnergyUsed, [5]);
    assert.deepEqual(result.saved, [3]);
    assert.deepEqual(result.batteryDischarging, [0]);
    assert.deepEqual(result.batteryCharging, [3]);
    assert.equal(context.entries.length, 2, 'saved history remains unchanged');
});

test('new-schema missing battery falls back while legacy-only days and modern repeats remain', () => {
    const {context} = page('energy-graph');
    const legacy = {...day, consumption_on_network: 2, solar_panel: 6, house_consumption: 8};
    const unavailable = {...legacy, battery_discharging: null, battery_charging: null, house_consumption: null};
    const legacyOnly = {...legacy, start_date: '2026-10-14T10:00:00.000Z'};
    context.entries = [legacy, unavailable, unavailable, legacyOnly];
    vm.runInContext('rawFlattenedData = preferBatteryAwareCalculations(entries)', context);
    assert.equal(vm.runInContext('rawFlattenedData.length', context), 3,
        'only same-day legacy data is removed; repeated modern calculations are retained');
    const result = JSON.parse(JSON.stringify(vm.runInContext("aggregateData('day')", context)));
    assert.deepEqual(result.totalEnergyUsed, [8, 8]);
    assert.deepEqual(result.batteryDischarging, [null, null]);
    assert.deepEqual(result.batteryCharging, [null, null]);
    assert.deepEqual(result.saved, [6, 6]);
});

test('new-schema missing solar retains gaps when it supersedes a legacy daily calculation', () => {
    const {context} = page('energy-graph');
    const legacy = {...day, consumption_on_network: 2, solar_panel: 6, house_consumption: 8};
    const unavailable = {...legacy, solar_panel: null,
        battery_discharging: null, battery_charging: null, house_consumption: null};
    context.entries = [legacy, unavailable];
    vm.runInContext('rawFlattenedData = preferBatteryAwareCalculations(entries)', context);
    const result = JSON.parse(JSON.stringify(vm.runInContext("aggregateData('day')", context)));
    assert.deepEqual(result.totalEnergyUsed, [null]);
    assert.deepEqual(result.saved, [null]);
});

test('complete battery history supersedes same-day fallback calculations without inflating totals', () => {
    const {context} = page('energy-graph');
    const incomplete = {...day, consumption_on_network: 2, solar_panel: 6,
        battery_discharging: null, battery_charging: null};
    const complete = {...incomplete, start_date: '2026-10-13T14:00:00.000Z',
        battery_discharging: 0, battery_charging: 3, house_consumption: 5};
    context.entries = [incomplete, complete];
    vm.runInContext('rawFlattenedData = preferBatteryAwareCalculations(entries)', context);
    assert.equal(vm.runInContext('rawFlattenedData.length', context), 1);
    for (const aggregation of ['day', 'month']) {
        const result = JSON.parse(JSON.stringify(vm.runInContext(`aggregateData('${aggregation}')`, context)));
        assert.deepEqual(result.totalEnergyUsed, [5]);
        assert.deepEqual(result.saved, [3]);
    }
});

test('complete zero battery history retains solar gaps instead of selecting a same-day fallback', () => {
    const {context} = page('energy-graph');
    const incomplete = {...day, consumption_on_network: 2, solar_panel: 6,
        battery_discharging: null, battery_charging: null};
    const complete = {...incomplete, solar_panel: null,
        battery_discharging: 0, battery_charging: 0, house_consumption: null};
    context.entries = [incomplete, complete, complete];
    vm.runInContext('rawFlattenedData = preferBatteryAwareCalculations(entries)', context);
    assert.equal(vm.runInContext('rawFlattenedData.length', context), 2,
        'repeats within the complete battery tier remain');
    const result = JSON.parse(JSON.stringify(vm.runInContext("aggregateData('month')", context)));
    assert.deepEqual(result.totalEnergyUsed, [null]);
    assert.deepEqual(result.saved, [null]);
    assert.deepEqual(result.batteryDischarging, [0]);
    assert.deepEqual(result.batteryCharging, [0]);
});

test('invalid negative battery readings do not supersede complete zero readings for the same day', () => {
    const {context} = page('energy-graph');
    const invalid = {...day, consumption_on_network: 2, solar_panel: 6,
        battery_discharging: -1, battery_charging: 0, house_consumption: 9};
    const complete = {...invalid, battery_discharging: 0, house_consumption: 8};
    context.entries = [invalid, complete];
    vm.runInContext('rawFlattenedData = preferBatteryAwareCalculations(entries)', context);
    const result = JSON.parse(JSON.stringify(vm.runInContext("aggregateData('day')", context)));
    assert.deepEqual(result.totalEnergyUsed, [8]);
    assert.deepEqual(result.batteryDischarging, [0]);
});
