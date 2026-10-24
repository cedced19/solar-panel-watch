const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ejs = require('ejs');

const timestamp = minute => `2026-10-13T10:0${minute}:00.000Z`;
const points = values => values.map((_value, minute) => ({_time: timestamp(minute), _value}));
const balance = () => ({
    power1: points([5000, 0, -100]), power2: points([6]),
    battery_discharging: points([400, null, 0]), battery_charging: points([30, null, 0]),
    house_consumption: points([123, null, 0])
});
const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));

function createPage(name, reply, {devices = [], language, labels = {}} = {}) {
    const translations = language && require('../lib/locales/' + language + '.json');
    const filename = path.resolve(__dirname, '../views', name + '.ejs');
    const html = ejs.render(fs.readFileSync(filename, 'utf8'), {
        period: '24h', timezone: 'Europe/Vienna', list_devices: devices, asset: url => url,
        __: label => labels[label] || (translations ? translations[label] : label)
    }, {filename});
    const nodes = {};
    const events = new Map();
    const requests = [];
    const plots = [];
    const decode = value => value.replace(/&#34;/g, '"').replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    function element(id) {
        const node = {
            id, dataset: {}, style: {}, hidden: false, textContent: '', children: [],
            appendChild(child) { this.children.push(child); if (child.id) nodes[child.id] = child; },
            setAttribute(key, value) { this[key] = String(value); }
        };
        if (id) nodes[id] = node;
        return node;
    }
    const page = element('consumption-power-page');
    const main = html.match(/<main\b[^>]+>/)[0];
    for (const match of main.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
        const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        page.dataset[key] = decode(match[2]);
    }
    element('loader');
    element('graphs-container').parentNode = element();
    element('consumption-power-status');
    // Avoid needing a full DOM merely to mount the shared downsampling control.
    element('downsample-select');
    const sandbox = {
        innerHeight: 800, innerWidth: 1000,
        addEventListener(name, callback) { events.set(name, callback); },
        document: {getElementById: id => nodes[id], querySelectorAll: () => [], createElement: () => element()},
        console, setTimeout, clearTimeout,
        fetch: async url => {
            requests.push(url);
            const result = typeof reply === 'function' ? await reply(url) : reply;
            return {ok: result.ok !== false, status: result.status || 200,
                json: async () => result.data, text: async () => result.text};
        },
        Plotly: {async newPlot(target, traces, layout, config) { plots.push({target, traces, layout, config}); }, relayout() {}}
    };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    for (const script of html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)) {
        if (!['/assets/influx-csv.js', '/assets/consumption-graph.js'].includes(script[1])) continue;
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..' + script[1]), 'utf8'), context,
            {filename: script[1]});
    }
    return {context, nodes, requests, plots, html, load: () => events.get('load')()};
}

for (const name of ['graph-power', 'device-list-graph-power']) {
    test(`${name} plots the server total and battery powers with gaps on their actual timestamps`, async () => {
        const data = balance();
        // Sources deliberately disagree with the total: the browser must not
        // recompute a sum by array index or assume matching measurement times.
        data.power2[0]._time = timestamp(2);
        const page = createPage(name, {data});
        await page.load();
        assert.deepEqual(page.requests, ['/api/data/consumption/24h?every=1m']);
        assert.equal(page.plots.length, 1);
        const {traces, layout} = page.plots[0];
        assert.deepEqual(plain(traces.map(trace => trace.name)), [
            'Network power', 'Solar panel production', 'Battery discharging power', 'Battery charging power', 'Total Power'
        ]);
        assert.deepEqual(plain(traces[4].y), [123, null, 0]);
        assert.deepEqual(plain(traces[3].y), [30, null, 0], 'charging stays a positive measured component');
        assert.deepEqual(plain(traces[0].y), [5000, 0, -100], 'signed grid exchange remains visible');
        assert.deepEqual(plain(traces[1].x), ['2026-10-13T12:02:00.000']);
        assert.deepEqual(plain(traces[4].x), [
            '2026-10-13T12:00:00.000', '2026-10-13T12:01:00.000', '2026-10-13T12:02:00.000'
        ]);
        assert.ok(traces.every(trace => trace.connectgaps === false));
        assert.equal(layout.yaxis.ticksuffix, ' W');
        assert.equal(page.nodes.loader.style.display, 'none');
        assert.equal(page.nodes['consumption-power-status'].hidden, true);
    });
}

test('the consumption request honours auto, explicit duration and raw downsampling', async () => {
    const page = createPage('graph-power', {data: balance()});
    for (const every of ['auto', '15m', 'raw']) {
        page.context.currentDownsample = every;
        await page.load();
    }
    assert.deepEqual(page.requests, [
        '/api/data/consumption/24h', '/api/data/consumption/24h?every=15m', '/api/data/consumption/24h?raw=true'
    ]);
});

test('device graphs preserve named stepped device curves and CSV downsampling', async () => {
    const page = createPage('device-list-graph-power', url => url.includes('/consumption/') ?
        {data: balance()} : {text: '_time,_value\n2026-10-13T10:00:00.000Z,75\n2026-10-13T10:01:00.000Z,0'},
    {devices: ['water-heater', 'garage-light']});
    page.context.currentDownsample = '5m';
    await page.load();
    assert.deepEqual(page.requests, [
        '/api/data/consumption/24h?every=5m',
        '/api/data/power/water-heater/24h?format=csv&every=5m',
        '/api/data/power/garage-light/24h?format=csv&every=5m'
    ]);
    const traces = page.plots[0].traces;
    assert.deepEqual(plain(traces.slice(4, 6).map(trace => trace.name)), ['Water Heater', 'Garage Light']);
    assert.ok(traces.slice(4, 6).every(trace => trace.line.shape === 'hv'));
    assert.deepEqual(plain(traces[4].y), [75, 0]);
    assert.deepEqual(plain(traces[6].y), [123, null, 0]);
});

test('device names in page attributes safely retain quotes and apostrophes', async () => {
    const page = createPage('device-list-graph-power', url => url.includes('/consumption/') ?
        {data: balance()} : {text: '_time,_value\n2026-10-13T10:00:00.000Z,75'},
    {devices: ['child\'s-"lamp"']});
    await page.load();
    assert.equal(page.plots[0].traces[4].name, 'Child\'s "lamp"');
});

test('device history HTTP failures hide the loader and show the localized message', async () => {
    const page = createPage('device-list-graph-power', url => url.includes('/consumption/') ?
        {data: balance()} : {ok: false, status: 503, text: 'offline'}, {devices: ['water-heater']});
    await page.load();
    assert.equal(page.plots.length, 0);
    assert.equal(page.nodes.loader.style.display, 'none');
    assert.equal(page.nodes['consumption-power-status'].hidden, false);
    assert.equal(page.nodes['consumption-power-status'].textContent, 'Power history unavailable');
});

test('both pages receive translated graph labels and messages through safe page attributes', async () => {
    for (const language of ['en', 'fr']) {
        const translations = require('../lib/locales/' + language + '.json');
        for (const name of ['graph-power', 'device-list-graph-power']) {
            const page = createPage(name, {data: balance()}, {language});
            await page.load();
            const labels = ['Network power', 'Solar panel production', 'Battery discharging power',
                'Battery charging power', 'Total Power'];
            assert.deepEqual(plain(page.plots[0].traces.map(trace => trace.name)), labels.map(key => translations[key]));
            for (const key of ['Power history unavailable', 'No power readings', 'Total power unavailable']) {
                assert.ok(translations[key], language + ' defines ' + key);
            }
            assert.equal(page.nodes['consumption-power-page'].dataset.errorLabel, translations['Power history unavailable']);
            assert.equal(page.nodes['consumption-power-page'].dataset.totalUnavailableLabel, translations['Total power unavailable']);
        }
    }
});

test('unavailable total readings retain component plots and show a localized explanation', async () => {
    const data = balance();
    data.house_consumption = points([null, null, null]);
    const page = createPage('graph-power', {data}, {labels: {'Total power unavailable': 'Total indisponible'}});
    await page.load();
    assert.equal(page.plots.length, 1);
    assert.deepEqual(plain(page.plots[0].traces[4].y), [null, null, null]);
    assert.equal(page.nodes['graphs-container'].hidden, false);
    assert.equal(page.nodes['consumption-power-status'].hidden, false);
    assert.equal(page.nodes['consumption-power-status'].textContent, 'Total indisponible');
});

test('historical totals remain visible when the server omits unavailable battery flows', async () => {
    const data = balance();
    data.power1 = points([600, -100, 0]);
    data.power2 = points([1200, 200, 0]);
    data.battery_discharging = [];
    data.battery_charging = [];
    data.house_consumption = points([1800, 100, 0]);
    const page = createPage('graph-power', {data});
    await page.load();
    assert.equal(page.plots.length, 1);
    assert.deepEqual(plain(page.plots[0].traces[4].y), [1800, 100, 0]);
    assert.deepEqual(plain(page.plots[0].traces[2].y), []);
    assert.deepEqual(plain(page.plots[0].traces[3].y), []);
    assert.equal(page.nodes['consumption-power-status'].hidden, true);
});

for (const reply of [
    {ok: false, status: 503, data: {error: 'offline'}},
    {data: {power1: []}},
    () => { throw new Error('Network disconnected'); }
]) {
    test('failed power history requests hide the loader and show a localized message', async () => {
        const page = createPage('graph-power', reply, {labels: {'Power history unavailable': 'Graphique indisponible'}});
        await page.load();
        assert.equal(page.plots.length, 0);
        assert.equal(page.nodes.loader.style.display, 'none');
        assert.equal(page.nodes['graphs-container'].hidden, true);
        assert.equal(page.nodes['consumption-power-status'].hidden, false);
        assert.equal(page.nodes['consumption-power-status'].textContent, 'Graphique indisponible');
    });
}

test('empty power history shows the empty-period message', async () => {
    const data = Object.fromEntries(Object.keys(balance()).map(field => [field, []]));
    const page = createPage('graph-power', {data});
    await page.load();
    assert.equal(page.plots.length, 0);
    assert.equal(page.nodes.loader.style.display, 'none');
    assert.equal(page.nodes['consumption-power-status'].textContent, 'No power readings');
});

test('a superseded downsampling request cannot replace the newer graph', async () => {
    let finishFirst;
    const first = new Promise(resolve => { finishFirst = resolve; });
    const page = createPage('graph-power', url => url.includes('every=1m') ? first : {data: balance()});
    const loading = page.load();
    page.context.currentDownsample = 'raw';
    await page.load();
    const obsolete = balance();
    obsolete.house_consumption = points([9999]);
    finishFirst({data: obsolete});
    await loading;
    await settle();
    assert.equal(page.plots.length, 1);
    assert.deepEqual(plain(page.plots[0].traces[4].y), [123, null, 0]);
});
