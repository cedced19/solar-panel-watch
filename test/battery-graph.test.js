const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const graphSource = fs.readFileSync(path.resolve(__dirname, '../assets/battery-graph.js'), 'utf8');

function element(dataset = {}) {
    const events = new Map();
    const attributes = new Map();
    return {
        dataset, hidden: false, disabled: false, textContent: '', events,
        addEventListener(name, callback) { events.set(name, callback); },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        removeAttribute(name) { attributes.delete(name); },
        getAttribute(name) { return attributes.get(name) ?? null; }
    };
}

function response(points, ok = true) {
    return {ok, json: async () => points};
}

function createPage(replies, {period = '24h', timezone = 'Europe/Vienna'} = {}) {
    const nodes = {
        'battery-history-page': element({period, timezone, title: 'Battery level history',
            socLabel: 'State of charge', powerLabel: 'Power (W)', homePowerLabel: 'Output to home',
            gridPowerLabel: 'Grid input', chargingPowerLabel: 'Battery charging power',
            dischargingPowerLabel: 'Battery discharging power', timeLabel: 'Time', emptyLabel: 'No battery readings yet.',
            errorLabel: 'Battery history is unavailable.', pollInterval: '20000'}),
        loader: element(),
        'battery-graph-card': element(),
        'graphs-container': element(),
        'battery-graph-status': element(),
        'battery-graph-message': element(),
        'battery-graph-retry': element()
    };
    const windowEvents = new Map();
    const requests = [];
    const plots = [];
    const sandbox = {
        document: {getElementById: (id) => nodes[id]},
        window: {innerHeight: 800, addEventListener(name, callback) { windowEvents.set(name, callback); }},
        console: {error() {}, warn() {}, log() {}},
        fetch(url) {
            requests.push(url);
            assert.ok(replies.length, 'a response is queued for each history request');
            return Promise.resolve(replies.shift());
        },
        Plotly: {
            async newPlot(container, traces, layout, config) {
                plots.push({container, traces, layout, config});
            }
        }
    };
    vm.runInNewContext(graphSource, sandbox, {filename: 'battery-graph.js'});
    const triggerLoad = () => windowEvents.get('load')();
    const retry = () => nodes['battery-graph-retry'].events.get('click')();
    return {nodes, requests, plots, triggerLoad, retry};
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the battery graph plots chronological SOC including 0 and 100 on a percentage axis', async () => {
    const page = createPage([response([
        {_time: '2026-10-12T09:02:00.000Z', _value: 100},
        {_time: 'invalid date', _value: 50},
        {_time: '2026-10-12T09:00:00.000Z', _value: 0},
        {_time: '2026-10-12T09:01:00.000Z', _value: 80.5},
        {_time: '2026-10-12T09:03:00.000Z', _value: 101},
        {_time: '2026-10-12T09:03:00.000Z', _value: '40'}
    ])]);
    await page.triggerLoad();
    await settle();
    assert.deepEqual(page.requests, ['/api/data/battery/24h']);
    assert.equal(page.plots.length, 1);
    const {container, traces, layout, config} = page.plots[0];
    assert.equal(container, page.nodes['graphs-container']);
    assert.equal(traces.length, 1);
    assert.deepEqual(plain(traces[0].y), [0, 80.5, 100]);
    assert.deepEqual(plain(traces[0].x), [
        '2026-10-12T11:00:00.000', '2026-10-12T11:01:00.000', '2026-10-12T11:02:00.000'
    ]);
    assert.deepEqual(plain(layout.yaxis.range), [0, 100]);
    assert.equal(layout.yaxis.ticksuffix, '%');
    assert.equal(layout.showlegend, false);
    assert.equal(layout.yaxis2, undefined);
    assert.equal(config.responsive, true);
    assert.equal(page.nodes.loader.hidden, true);
    assert.equal(page.nodes['battery-graph-card'].hidden, false);
    assert.equal(page.nodes['battery-graph-status'].hidden, true);
    assert.equal(page.nodes['battery-history-page'].getAttribute('aria-busy'), 'false');
});

test('battery history plots all four powers on a shared watt axis beside SOC', async () => {
    const page = createPage([response([
        {_time: '2026-10-12T09:01:00.000Z', _value: 55,
            outputHomePower: 900, gridInputPower: 20, outputPackPower: 320, packInputPower: 0},
        {_time: '2026-10-12T09:00:00.000Z', _value: 50,
            outputHomePower: 800, gridInputPower: 10, outputPackPower: 300, packInputPower: 0}
    ])]);
    await page.triggerLoad();
    const {traces, layout} = page.plots[0];
    assert.equal(traces.length, 5);
    assert.deepEqual(plain(traces.map((trace) => trace.name)), [
        'State of charge', 'Output to home', 'Grid input', 'Battery charging power', 'Battery discharging power'
    ]);
    assert.deepEqual(plain(traces.map((trace) => trace.y)), [[50, 55], [800, 900], [10, 20], [300, 320], [0, 0]]);
    assert.deepEqual(plain(layout.yaxis.range), [0, 100]);
    assert.equal(layout.yaxis2.title, 'Power (W)');
    assert.equal(layout.yaxis2.overlaying, 'y');
    assert.equal(layout.yaxis2.side, 'right');
    assert.equal(layout.yaxis2.ticksuffix, ' W');
    assert.equal(layout.showlegend, true);
    assert.equal(new Set(traces.map((trace) => trace.line.color)).size, 5);
    for (const trace of traces.slice(1)) {
        assert.deepEqual(plain(trace.x), plain(traces[0].x));
        assert.equal(trace.yaxis, 'y2');
        assert.equal(trace.connectgaps, false);
        assert.match(trace.hovertemplate, / W/);
    }
});

test('missing and invalid power samples create gaps while measured zero remains visible', async () => {
    const page = createPage([response([
        {_time: '2026-10-12T09:00:00.000Z', _value: 60, outputHomePower: 0, gridInputPower: null},
        {_time: '2026-10-12T09:01:00.000Z', _value: 61, outputHomePower: null, gridInputPower: '10', outputPackPower: -1},
        {_time: '2026-10-12T09:02:00.000Z', _value: 62, outputHomePower: 600, gridInputPower: Infinity},
        {_time: '2026-10-12T09:03:00.000Z', _value: 63},
        {_time: '2026-10-12T09:04:00.000Z', _value: 64, outputHomePower: '700'}
    ])]);
    await page.triggerLoad();
    const {traces} = page.plots[0];
    assert.equal(traces.length, 2, 'entirely unavailable power series stay out of the legend');
    assert.deepEqual(plain(traces[0].y), [60, 61, 62, 63, 64]);
    assert.deepEqual(plain(traces[1].y), [0, null, 600, null, null]);
    assert.equal(traces[1].connectgaps, false);
    assert.equal(traces[1].mode, 'lines+markers', 'isolated samples remain visible');
});

test('power readings can still display when SOC is unavailable, with gaps in the SOC trace', async () => {
    const page = createPage([response([
        {_time: '2026-10-12T09:00:00.000Z', _value: 50, outputHomePower: 100},
        {_time: '2026-10-12T09:01:00.000Z', _value: null, outputHomePower: 0},
        {_time: '2026-10-12T09:02:00.000Z', _value: 52, outputHomePower: 120}
    ])]);
    await page.triggerLoad();
    assert.equal(page.plots.length, 1);
    assert.deepEqual(plain(page.plots[0].traces[0].y), [50, null, 52]);
    assert.deepEqual(plain(page.plots[0].traces[1].y), [100, 0, 120]);
    assert.equal(page.plots[0].traces[0].connectgaps, false);
});

test('battery graph provides English and French legend and watt axis labels through the page', () => {
    const ejs = require('ejs');
    const template = fs.readFileSync(path.resolve(__dirname, '../views/graph-battery.ejs'), 'utf8');
    for (const language of ['en', 'fr']) {
        const translations = require('../lib/locales/' + language + '.json');
        const html = ejs.render(template, {period: '24h', timezone: 'Europe/Vienna', __: (key) => translations[key]});
        for (const [attribute, key] of [
            ['home-power-label', 'Output to home'],
            ['grid-power-label', 'Grid input'],
            ['charging-power-label', 'Battery charging power'],
            ['discharging-power-label', 'Battery discharging power'],
            ['power-label', 'Power (W)']
        ]) {
            assert.ok(translations[key], language + ' defines ' + key);
            assert.ok(html.includes('data-' + attribute + '="' + translations[key] + '"'));
        }
    }
});

test('the battery graph keeps loading visible while waiting for history', async () => {
    let resolveHistory;
    const pendingHistory = new Promise((resolve) => { resolveHistory = resolve; });
    const page = createPage([pendingHistory]);
    const loading = page.triggerLoad();
    assert.equal(page.nodes.loader.hidden, false);
    assert.equal(page.nodes['battery-history-page'].getAttribute('aria-busy'), 'true');
    resolveHistory(response([{_time: '2026-10-12T09:00:00.000Z', _value: 50}]));
    await loading;
    await settle();
    assert.equal(page.nodes.loader.hidden, true);
    assert.equal(page.plots.length, 1);
});

test('empty history shows a localized message and retry can load newly recorded SOC', async () => {
    const page = createPage([
        response([]),
        response([{_time: '2026-10-12T09:00:00.000Z', _value: 67}])
    ], {period: '7d'});
    await page.triggerLoad();
    await settle();
    assert.equal(page.plots.length, 0);
    assert.equal(page.nodes.loader.hidden, true);
    assert.equal(page.nodes['battery-graph-card'].hidden, true);
    assert.equal(page.nodes['battery-graph-status'].hidden, false);
    assert.equal(page.nodes['battery-graph-message'].textContent, 'No battery readings yet.');
    await page.retry();
    await settle();
    assert.deepEqual(page.requests, ['/api/data/battery/7d', '/api/data/battery/7d']);
    assert.equal(page.plots.length, 1);
    assert.deepEqual(plain(page.plots[0].traces[0].y), [67]);
    assert.equal(page.nodes['battery-graph-status'].hidden, true);
});

test('API failure hides the loader, shows a localized error and retry restores the graph', async () => {
    const page = createPage([
        response({error: 'database offline'}, false),
        response([{_time: '2026-10-12T09:00:00.000Z', _value: 81}])
    ]);
    await page.triggerLoad();
    await settle();
    assert.equal(page.plots.length, 0);
    assert.equal(page.nodes.loader.hidden, true);
    assert.equal(page.nodes['battery-graph-card'].hidden, true);
    assert.equal(page.nodes['battery-graph-status'].hidden, false);
    assert.equal(page.nodes['battery-graph-message'].textContent, 'Battery history is unavailable.');
    assert.equal(page.nodes['battery-graph-retry'].disabled, false);
    await page.retry();
    await settle();
    assert.equal(page.plots.length, 1);
    assert.equal(page.nodes['battery-graph-card'].hidden, false);
    assert.equal(page.nodes['battery-graph-status'].hidden, true);
});
