const assert = require('node:assert/strict');
const test = require('node:test');
const {pointsToCSV} = require('../lib/victoria-lib');

test('CSV defaults preserve the existing two-column power and SOC export', () => {
    assert.equal(pointsToCSV([]), '_time,_value');
    assert.equal(pointsToCSV([
        {_time: '2026-10-12T10:00:00Z', _value: 0},
        {_time: '2026-10-12T10:00:20Z', _value: 100}
    ]), '_time,_value\n2026-10-12T10:00:00Z,0\n2026-10-12T10:00:20Z,100');
});

test('CSV exports chosen battery history columns and leaves absent or null readings blank', () => {
    const columns = ['_time', '_value', 'outputHomePower', 'gridInputPower', 'outputPackPower', 'packInputPower'];
    assert.equal(pointsToCSV([
        {_time: '2026-10-12T10:00:00Z', _value: 80},
        {_time: '2026-10-12T10:00:20Z', _value: 81, outputHomePower: 250,
            gridInputPower: 0, outputPackPower: 100, packInputPower: 0},
        {_time: '2026-10-12T10:00:40Z', _value: null, outputHomePower: 200,
            gridInputPower: null, outputPackPower: undefined}
    ], columns),
    '_time,_value,outputHomePower,gridInputPower,outputPackPower,packInputPower' +
    '\n2026-10-12T10:00:00Z,80,,,,' +
    '\n2026-10-12T10:00:20Z,81,250,0,100,0' +
    '\n2026-10-12T10:00:40Z,,200,,,');
});
