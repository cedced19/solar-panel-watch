const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const {createAssetUrl} = require('../lib/asset-url');
const {app} = require('../main');

const viewsDir = path.resolve(__dirname, '../views');
const views = fs.readdirSync(viewsDir).filter(name => name.endsWith('.ejs'));

function get(server, route) {
    return new Promise((resolve, reject) => {
        http.get({host: '127.0.0.1', port: server.address().port, path: route}, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body}));
        }).on('error', reject);
    });
}

test('asset urls carry the version in a cache parameter', () => {
    const asset = createAssetUrl(1761300000000);
    assert.equal(asset('/assets/styles.css'), '/assets/styles.css?cache=1761300000000');
    assert.equal(createAssetUrl('a b')('/assets/nav.js'), '/assets/nav.js?cache=a%20b');
});

test('every JS and CSS file of the views is linked through asset()', () => {
    assert.ok(views.length > 0);
    for (const name of views) {
        const template = fs.readFileSync(path.join(viewsDir, name), 'utf8');
        const bare = template.match(/\b(?:src|href)=["']?\/assets\/[\w.-]+\.(?:js|css)\b/g);
        assert.equal(bare, null, name + ' links an asset without asset(): ' + bare);
    }
});

test('the served pages link their JS and CSS with the start time of the app', async t => {
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));

    const versions = new Set();
    for (const route of ['/force/', '/graph/power/24h', '/energy/current-day', '/energy-calendar/', '/nomenclature/']) {
        const response = await get(server, route);
        assert.equal(response.status, 200, route);
        const links = [...response.body.matchAll(/\b(?:src|href)="(\/assets\/[\w.-]+\.(?:js|css))([^"]*)"/g)];
        assert.ok(links.length > 0, route + ' links assets');
        for (const [, file, query] of links) {
            assert.match(query, /^\?cache=\d+$/, route + ' ' + file);
            versions.add(query);
        }
    }
    assert.equal(versions.size, 1, 'one version for the whole run of the app');
    const first = [...versions][0];
    const asset = await get(server, '/assets/styles.css' + first);
    assert.equal(asset.status, 200, 'the static handler ignores the query');
});
