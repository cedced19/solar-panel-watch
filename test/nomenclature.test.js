const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ejs = require('ejs');
const {app} = require('../main');
const getPowerData = require('../lib/get-power-data');

function request(server, route, language) {
    return new Promise((resolve, reject) => {
        http.get({host: '127.0.0.1', port: server.address().port, path: route,
            headers: language ? {'accept-language': language} : {}}, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body}));
        }).on('error', reject);
    });
}

test('the public nomenclature page follows i18n and switches languages without needing live meters', async t => {
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const originalPower = getPowerData.req;
    const originalBattery = getPowerData.reqBattery;
    getPowerData.req = () => { throw new Error('Educational page must not request live power'); };
    getPowerData.reqBattery = () => { throw new Error('Educational page must not request battery data'); };
    t.after(() => {
        getPowerData.req = originalPower;
        getPowerData.reqBattery = originalBattery;
        return new Promise(resolve => server.close(resolve));
    });

    for (const [route, header, expected] of [
        ['/nomenclature/', 'en-US', 'en'],
        ['/nomenclature/', 'fr-FR', 'fr'],
        ['/nomenclature/', 'de', 'en'],
        ['/nomenclature/', undefined, 'en'],
        ['/nomenclature/?lang=fr', 'en', 'fr'],
        ['/nomenclature/?lang=en', 'fr', 'en'],
        ['/nomenclature/?lang=unsupported', 'fr', 'fr']
    ]) {
        const response = await request(server, route, header);
        assert.equal(response.status, 200, route);
        assert.equal(response.headers['content-language'], expected);
        assert.match(response.headers.vary, /Accept-Language/);
        assert.match(response.body, new RegExp(`<html\\s+lang=["']${expected}["']`));
        const labels = require('../lib/locales/' + expected + '.json');
        assert.ok(response.body.includes(labels['Network power']));
        assert.ok(response.body.includes(labels['Battery charging power']));
        assert.ok(response.body.includes(labels['Battery discharging power']));
        assert.match(response.body, /href="\/nomenclature\/\?lang=fr"/);
        assert.match(response.body, /href="\/nomenclature\/\?lang=en"/);
        assert.match(response.body, /<script[^>]*id="MathJax-script"[^>]*async[^>]*src="https:\/\/cdn\.jsdelivr\.net\/npm\/mathjax@4\/tex-mml-chtml\.js"/);
        assert.match(response.body, /<script[^>]*id="Mermaid-script"[^>]*src="https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@11\.4\.1\/dist\/mermaid\.min\.js"/);
        assert.match(response.body, /href="#activation-logic"/);
        for (const id of ['activation-logic', 'battery-logic', 'device-logic']) {
            assert.match(response.body, new RegExp(`id="${id}"`));
        }
        assert.ok(response.body.includes(ejs.escapeXML(labels['Nomenclature logic title'])));
        assert.equal(response.body.match(/<pre class="mermaid nomenclature-mermaid">/g).length, 3);
        assert.match(response.body, /flowchart TD/);
        assert.doesNotMatch(response.body, /\b(?:packInputPower|outputPackPower|house_consumption|_value)\b/);
        for (const inline of response.body.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
            new vm.Script(inline[1]);
        }
    }
    for (const route of ['/graph/power/24h', '/device/list/graph/24h', '/energy/current-day',
        '/energy-graph/', '/energy-calendar/']) {
        const response = await request(server, route, 'fr');
        assert.equal(response.status, 200);
        assert.match(response.body, /href="\/nomenclature\/"/);
    }
});

test('all educational copy and accessible diagram labels have English and French translations', () => {
    const filename = path.resolve(__dirname, '../views/nomenclature.ejs');
    const template = fs.readFileSync(filename, 'utf8');
    const copies = [];
    for (const locale of ['en', 'fr']) {
        const labels = require('../lib/locales/' + locale + '.json');
        const html = ejs.render(template, {locale, asset: url => url, __: key => {
            assert.equal(typeof labels[key], 'string', locale + ' defines ' + key);
            assert.ok(labels[key].trim(), locale + ' has copy for ' + key);
            if (key.startsWith('Nomenclature ')) {
                assert.notEqual(labels[key], key, locale + ' translates ' + key);
            }
            return labels[key];
        }}, {filename});
        assert.match(html, /<svg[^>]*role="img"[^>]*aria-labelledby=/);
        assert.match(html, /<title\b[^>]*>[^<]+<\/title>/);
        assert.match(html, /<desc\b[^>]*>[^<]+<\/desc>/);
        assert.match(html, /kWh/);
        assert.doesNotMatch(html, /<%|undefined|NaN/);
        copies.push(html);
    }
    assert.notEqual(copies[0], copies[1]);
});
