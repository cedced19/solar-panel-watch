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
    });
    const nodes = new Map();
    const cells = [];
    function element(tag) {
        const node = {children: [], style: {}, textContent: '',
            appendChild(child) { this.children.push(child); }, addEventListener() {}};
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
        window: {addEventListener() {}}, console,
        fetch: async () => ({json: async () => data})
    });
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        vm.runInContext(script[1], context);
    }
    return {context, cells};
}

const day = {
    start_date: '2026-10-13T10:00:00.000Z', end_date: '2026-10-13T10:01:00.000Z',
    consumption_on_network: 0.012, introduced_on_network: 0,
    solar_panel: null, house_consumption: null
};

for (const name of ['energy-calendar', 'energy', 'energy-request-hist']) {
    test(`${name} displays unavailable solar, house and savings while retaining grid totals`, async () => {
        const data = name === 'energy-request-hist' ?
            [{date: day.start_date, period: '2026-10-13', result: [day]}] : [day];
        const {context, cells} = page(name, data);
        if (name === 'energy-calendar') {
            context.energyData = data;
            vm.runInContext('renderDay("2026-10-13", energyData)', context);
        } else {
            vm.runInContext('loadData()', context);
            await new Promise(resolve => setImmediate(resolve));
        }
        const text = cells.map(cell => cell.children.length ?
            cell.children.map(child => child.textContent).join('') : String(cell.textContent));
        assert.deepEqual(text.slice(2), ['0.012', 'Unavailable', 'Unavailable', '0', 'Unavailable']);
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
        assert.equal(result.saved[0], null);
        assert.equal(result.totalEnergyUsed[0], null);
        assert.equal(result.consumption[0], aggregation === 'day' ? 0.012 : 0.024);
    }
    assert.equal(vm.runInContext('calculateMovingAverage([null, 1, 2], 3)[0]', context), null);
});
