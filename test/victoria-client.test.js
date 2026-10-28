const assert = require('node:assert/strict');
const test = require('node:test');
const {createVictoriaClient, selector, formatLine, metricName} = require('../lib/victoria-client');

// A fetch that records requests and answers with the given body, sent in
// chunks to exercise the line splitting.
function fakeFetch(answer) {
    const requests = [];
    const fetch = async (url, init) => {
        requests.push({url, method: init.method, body: init.body});
        const {status = 200, body = '', chunkSize = 7} = typeof answer === 'function' ? answer(url, init.body) : answer;
        const bytes = new TextEncoder().encode(body);
        return {
            ok: status >= 200 && status < 300,
            status,
            text: async () => body,
            json: async () => JSON.parse(body),
            body: (async function* () {
                for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.slice(i, i + chunkSize);
            })()
        };
    };
    return {fetch, requests};
}

test('line protocol escapes names, keeps finite fields only and stamps milliseconds', () => {
    assert.equal(metricName('power', 'chauffe-eau'), 'power_chauffe-eau');
    assert.equal(formatLine('power', {home: 'home 1'}, {power1: -350.5, bad: NaN, 'a,b': 0, inf: Infinity}, 1780000000123.4),
        'power,home=home\\ 1 power1=-350.5,a\\,b=0 1780000000123');
    assert.equal(formatLine('power', {home: 'h'}, {power1: null, power2: Infinity}, 1), null);
});

test('selectors quote every name and label, so a name cannot change the query', () => {
    assert.equal(selector('power_power1', {home: 'home1'}), '{__name__="power_power1",home="home1"}');
    assert.equal(selector(['a', 'b'], {home: 'h'}), '{__name__="a",home="h" or __name__="b",home="h"}');
    assert.equal(selector('x"} or {__name__=~".*', {home: 'a\\b'}),
        String.raw`{__name__="x\"} or {__name__=~\".*",home="a\\b"}`);
});

test('writes post line protocol with millisecond precision and report rejections with their status', async () => {
    const {fetch, requests} = fakeFetch({status: 204});
    const client = createVictoriaClient({url: 'http://vm:8428/', fetch});
    await client.write(['a f=1 1', 'a f=2 2']);
    assert.deepEqual(requests, [{url: 'http://vm:8428/write?precision=ms', method: 'POST', body: 'a f=1 1\na f=2 2'}]);

    const failing = createVictoriaClient({url: 'http://vm:8428', fetch: fakeFetch({status: 400, body: 'cannot parse\n'}).fetch});
    await assert.rejects(failing.write(['bad']), error => error.status === 400 && /answered 400: cannot parse$/.test(error.message));
});

test('an export streams each line as a series, whatever the chunk boundaries, over [start, stop)', async () => {
    const lines = [
        {metric: {__name__: 'power_power1', home: 'h'}, values: [1, 2], timestamps: [1000, 2000]},
        {metric: {__name__: 'power_power1', home: 'h'}, values: [3], timestamps: [3000]},
        {metric: {__name__: 'power_power2', home: 'h'}, values: [4], timestamps: [1500]}
    ];
    for (const chunkSize of [1, 5, 1000]) {
        const {fetch, requests} = fakeFetch({body: lines.map(line => JSON.stringify(line)).join('\n') + '\n', chunkSize});
        const client = createVictoriaClient({url: 'http://vm:8428', fetch});
        const received = [];
        await client.exportSeries([selector('power_power1'), selector('power_power2')], 1000, 4000, series => received.push(series));
        assert.deepEqual(received, lines);
        const params = requests[0].body;
        assert.equal(requests[0].url, 'http://vm:8428/api/v1/export');
        assert.deepEqual(params.getAll('match[]'), ['{__name__="power_power1"}', '{__name__="power_power2"}']);
        // The stop is excluded: VictoriaMetrics includes its end.
        assert.equal(params.get('start'), '1970-01-01T00:00:01.000Z');
        assert.equal(params.get('end'), '1970-01-01T00:00:03.999Z');
    }
    // The last line may come without a newline.
    const {fetch} = fakeFetch({body: JSON.stringify(lines[2])});
    const received = [];
    await createVictoriaClient({url: 'http://vm', fetch}).exportSeries('{a="b"}', 0, 1, series => received.push(series));
    assert.deepEqual(received, [lines[2]]);
});

test('window queries cover [t - step, t) on multiples of step and stamp the last window with stop', async () => {
    const minute = 60000;
    const start = 10 * minute + 20000;
    const stop = 13 * minute + 5000;
    const body = JSON.stringify({status: 'success', data: {resultType: 'matrix', result: [{
        metric: {__name__: 'power_power1', home: 'h'},
        values: [[(11 * minute - 1) / 1000, '1.5'], [(12 * minute - 1) / 1000, '-3'], [(14 * minute - 1) / 1000, '7']]
    }]}});
    const {fetch, requests} = fakeFetch({body});
    const result = await createVictoriaClient({url: 'http://vm', fetch}).queryWindows('q', start, stop, minute);
    assert.deepEqual(result, [{metric: {__name__: 'power_power1', home: 'h'},
        timestamps: [11 * minute, 12 * minute, stop], values: [1.5, -3, 7]}]);
    const params = requests[0].body;
    assert.equal(requests[0].url, 'http://vm/api/v1/query_range');
    assert.equal(params.get('query'), 'q');
    // Evaluated 1 ms before each window end, without the rounding of cached queries.
    assert.equal(params.get('start'), new Date(11 * minute - 1).toISOString());
    assert.equal(params.get('end'), new Date(14 * minute - 1).toISOString());
    assert.equal(params.get('step'), minute + 'ms');
    assert.equal(params.get('nocache'), '1');
});

test('window queries over a long range are asked a day of data at a time and merged per series', async () => {
    const hour = 3600 * 1000;
    const start = Date.UTC(2026, 9, 1, 0, 30);
    const stop = Date.UTC(2026, 9, 3, 12);
    // Answers one point per window for one series, and one at the start of the range for another.
    const {fetch, requests} = fakeFetch((url, params) => {
        const from = Date.parse(params.get('start'));
        const to = Date.parse(params.get('end'));
        const values = [];
        for (let t = from; t <= to; t += hour) values.push([t / 1000, String((t + 1 - start) / hour)]);
        const result = [{metric: {__name__: 'a'}, values}];
        if (from === Date.UTC(2026, 9, 1, 1) - 1) result.push({metric: {__name__: 'b'}, values: [[from / 1000, '9']]});
        return {body: JSON.stringify({data: {result}})};
    });
    const result = await createVictoriaClient({url: 'http://vm', fetch}).queryWindows('q', start, stop, hour);
    assert.deepEqual(requests.map(({body}) => [body.get('start'), body.get('end')]), [
        ['2026-10-01T00:59:59.999Z', '2026-10-01T23:59:59.999Z'],
        ['2026-10-02T00:59:59.999Z', '2026-10-02T23:59:59.999Z'],
        ['2026-10-03T00:59:59.999Z', '2026-10-03T11:59:59.999Z']
    ]);
    assert.equal(result.length, 2);
    // 60 windows end from 01:00 on the 1st to 12:00 on the 3rd, each once and in order.
    assert.equal(result[0].timestamps.length, 60);
    assert.deepEqual(result[0].timestamps.slice(0, 2), [Date.UTC(2026, 9, 1, 1), Date.UTC(2026, 9, 1, 2)]);
    assert.equal(result[0].timestamps.at(-1), stop);
    assert.ok(result[0].timestamps.every((time, i) => i === 0 || time - result[0].timestamps[i - 1] === hour));
    assert.deepEqual(result[1], {metric: {__name__: 'b'}, timestamps: [Date.UTC(2026, 9, 1, 1)], values: [9]});

    // A window longer than a day is asked on its own.
    requests.length = 0;
    await createVictoriaClient({url: 'http://vm', fetch}).queryWindows('q', start, stop, 2 * 24 * hour);
    assert.equal(requests.length, 2);
});

test('query errors reject with the answer of VictoriaMetrics', async () => {
    const {fetch} = fakeFetch({status: 422, body: '{"status":"error","error":"too many points"}'});
    const client = createVictoriaClient({url: 'http://vm', fetch});
    await assert.rejects(client.queryWindows('q', 0, 60000, 1000), error => error.status === 422 && /too many points/.test(error.message));
    await assert.rejects(client.exportSeries('{a="b"}', 0, 1, () => {}), error => error.status === 422);
    const down = createVictoriaClient({url: 'http://vm', fetch: async () => { throw new TypeError('fetch failed'); }});
    await assert.rejects(down.write(['a f=1 1']), TypeError);
});
