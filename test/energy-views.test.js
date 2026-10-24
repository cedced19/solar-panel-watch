const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ejs = require('ejs');

function page(name, data, locals) {
    const filename = path.resolve(__dirname, '../views', name + '.ejs');
    const html = ejs.render(fs.readFileSync(filename, 'utf8'), {
        __: label => label, day: '2026-10-13', timezone: 'Europe/Vienna', config: {}, ...locals
    }, {filename});
    const nodes = new Map();
    const cells = [];
    const plots = new Map();
    function element(tag) {
        const node = {children: [], style: {}, textContent: '', value: '', checked: false, listeners: {},
            appendChild(child) { this.children.push(child); },
            addEventListener(type, listener) { (this.listeners[type] = this.listeners[type] || []).push(listener); },
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
        window: {addEventListener() {}, innerWidth: 1200, location: {hash: ''}}, console,
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

async function renderTable(name, [row]) {
    const result = page(name, row);
    if (name === 'energy-calendar') {
        result.context.energyData = row;
        vm.runInContext('showDay(energyData)', result.context);
    } else {
        vm.runInContext('loadData()', result.context);
        await new Promise(resolve => setImmediate(resolve));
    }
    return result.cells.map(cell => cell.children.length ?
        cell.children.map(child => child.textContent).join('') : String(cell.textContent));
}

const day = {
    day: '2026-10-13', complete: true, start_date: '2026-10-13T10:00:00.000Z', end_date: '2026-10-13T10:01:00.000Z',
    consumption_on_network: 0.012, introduced_on_network: 0,
    solar_panel: null, house_consumption: null
};

// Local day of a fixture's start_date, as stored by the server.
const withDays = entries => entries.map(entry => {
    const date = new Date(entry.start_date);
    return {...entry, day: date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' +
        String(date.getDate()).padStart(2, '0')};
});

for (const name of ['energy-calendar', 'energy']) {
    test(`${name} displays unavailable solar, house and savings while retaining grid totals`, async () => {
        const text = await renderTable(name, [day]);
        assert.deepEqual(text.slice(2), ['0.012', 'Unavailable', 'Unavailable',
            'Unavailable', 'Unavailable', '0', 'Unavailable']);
    });

    test(`${name} shows battery energy and uses house consumption for totals and savings`, async () => {
        const text = await renderTable(name, [{...day, consumption_on_network: 2, solar_panel: 6,
            battery_discharging: 4, battery_charging: 3, introduced_on_network: -1, house_consumption: 8}]);
        assert.deepEqual(text.slice(2), ['2 (25%)', '6', '4', '3', '8', '-1', '6 (75%)']);
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
        assert.deepEqual(text.slice(2), ['2 (28%)', '6', 'Unavailable', 'Unavailable', '7', '-1', '5 (71%)']);
    });

    test(`${name} ignores both battery adjustments when either direction is missing`, async () => {
        for (const unavailable of ['battery_discharging', 'battery_charging']) {
            const row = {...day, consumption_on_network: 2, introduced_on_network: -1,
                solar_panel: 6, battery_discharging: 4, battery_charging: 3};
            delete row[unavailable];
            const text = await renderTable(name, [row]);
            assert.equal(text[6], '7');
            assert.equal(text[8], '5 (71%)');
        }
    });

    test(`${name} preserves the published decimal precision of totals and savings`, async () => {
        const text = await renderTable(name, [{...day, solar_panel: 0.025,
            battery_discharging: null, battery_charging: null}]);
        assert.equal(text[6], '0.037');
        assert.equal(text[8], '0.025 (67%)');
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
    context.entries = withDays([day, validDay]);
    vm.runInContext('setRows(entries)', context);
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
    context.entries = withDays([validDay, {...validDay, start_date: '2026-10-14T10:00:00.000Z'}]);
    vm.runInContext("setRows(entries); updateAllGraphs('month')", context);
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
    context.entries = withDays([{...day, solar_panel: 0.013, house_consumption: 0.025}]);
    vm.runInContext("setRows(entries); updateAllGraphs('year'); renderBreakdownTable()", context);
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
    context.entries = withDays([withoutBattery, partialBattery]);
    vm.runInContext('setRows(entries)', context);
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
    context.entries = withDays([{...day, consumption_on_network: 0.1, introduced_on_network: -0.2, solar_panel: 0.4}]);
    vm.runInContext('setRows(entries)', context);
    const result = JSON.parse(JSON.stringify(vm.runInContext("aggregateData('day')", context)));
    assert.deepEqual(result.totalEnergyUsed, [0.3]);
});

test('mixed fallback and battery-aware periods retain decimal precision in graphs and breakdown', () => {
    const {context, cells, plots} = page('energy-graph');
    context.entries = withDays([
        {...day, solar_panel: 0.025, battery_discharging: null, battery_charging: null},
        {...day, start_date: '2026-10-14T10:00:00.000Z', consumption_on_network: 0.007,
            solar_panel: 0.01, battery_discharging: 0.002, battery_charging: 0.004, house_consumption: 0.015}
    ]);
    vm.runInContext("setRows(entries); updateAllGraphs('month'); renderBreakdownTable()", context);
    assert.deepEqual(Array.from(plots.get('graph-total').traces[0].y), [0.052]);
    assert.deepEqual(Array.from(plots.get('graph-saved').traces[0].y), [0.033]);
    assert.deepEqual(cells.map(cell => String(cell.textContent)),
        ['2026', '0.019', '0.035', 'Unavailable', 'Unavailable', '0.052', '0']);
});

test('energy graph loads the #duration range, computes stale days, and recomputes a clicked day', async () => {
    const {context, nodes, plots} = page('energy-graph', null,
        {config: {latitude: '48.2', longitude: '16.4', timezone: 'Europe/Vienna'}});
    const now = new Date();
    const keys = [2, 1, 0].map(back => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back))
        .map(date => date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' +
            String(date.getDate()).padStart(2, '0'));
    const entry = (key, consumption) => ({...day, day: key, consumption_on_network: consumption, solar_panel: 1,
        battery_discharging: 0, battery_charging: 0, house_consumption: consumption + 1});
    const computed = {[keys[1]]: entry(keys[1], 2), [keys[2]]: {...entry(keys[2], 5), complete: false}};
    const urls = [];
    context.window.location.hash = '#duration=3';
    context.fetch = async (url, options) => {
        urls.push(options ? options.method + ' ' + url : url);
        let body = null;
        if (url.startsWith('/api/data/energy/days')) {
            body = {days: [entry(keys[0], 1), {...entry(keys[2], 4), complete: false},
                {...day, day: '2000-01-01', start_date: null}],
                stale: urls.length === 1 ? [keys[1], keys[2]] : []};
        } else if (url.endsWith('/recompute')) {
            body = entry(keys[1], 3);
        } else if (url.startsWith('/api/data/energy/day/')) {
            body = computed[url.split('/').pop()];
        }
        return {json: async () => body};
    };
    context.document.getElementById('aggregation-select').value = 'day';
    const clicks = [];
    context.document.getElementById('graph-consumption').on = (type, listener) => clicks.push(listener);
    const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
    const consumption = () => Array.from(plots.get('graph-consumption').traces[0].y);

    vm.runInContext('loadData()', context);
    await settle();
    assert.equal(urls[0], `/api/data/energy/days?start=${keys[0]}&end=${keys[2]}`);
    assert.deepEqual(urls.filter(url => url.startsWith('/api/data/energy/day/')),
        keys.slice(1).map(key => '/api/data/energy/day/' + key), 'stale days are computed one by one');
    assert.deepEqual([nodes.get('range-start').value, nodes.get('range-end').value], [keys[0], keys[2]]);
    assert.equal(nodes.get('range-end').max, keys[2]);
    assert.deepEqual(consumption(), [1, 2, 5], 'days without readings are not drawn');
    assert.equal(nodes.get('fill-progress').style.display, 'none');
    assert.ok(urls.some(url => url.includes('archive-api.open-meteo.com')));

    // Clicking the bar of a day shows its table, and recomputing it redraws the graphs.
    clicks.at(-1)({points: [{pointIndex: 1}]});
    assert.equal(nodes.get('day-section').style.display, 'block');
    const result = nodes.get('day-result');
    assert.equal(result.children[0].textContent, keys[1]);
    const button = result.children.find(child => child.className === 'energy-recompute');
    button.listeners.click[0]();
    await settle();
    assert.ok(urls.includes(`POST /api/data/energy/day/${keys[1]}/recompute`));
    assert.deepEqual(consumption(), [1, 3, 5]);

    // A shorter range only draws its own days.
    const end = nodes.get('range-end');
    end.value = keys[1];
    end.listeners.change.forEach(listener => listener({target: end}));
    await settle();
    assert.ok(urls.includes(`/api/data/energy/days?start=${keys[0]}&end=${keys[1]}`));
    assert.deepEqual(consumption(), [1, 3]);
});

test('energy graph without #duration loads the whole stored period up to today', async () => {
    const {context, nodes} = page('energy-graph');
    const urls = [];
    context.fetch = async url => {
        urls.push(url);
        return {json: async () => url.startsWith('/api/data/energy/days') ?
            {days: withDays([{...day, start_date: '2026-01-02T10:00:00.000Z'}]), stale: []} : null};
    };
    vm.runInContext('loadData()', context);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(urls[0], '/api/data/energy/days');
    assert.equal(nodes.get('range-start').value, '2026-01-02');
    assert.equal(nodes.get('range-end').value, vm.runInContext('localDayKey(new Date())', context));
    for (const [hash, days] of [['#duration=7', 7], ['#a=1&duration=30', 30], ['#duration=0', null], ['#x', null]]) {
        context.window.location.hash = hash;
        assert.equal(vm.runInContext('durationFromHash()', context), days, hash);
    }
});
