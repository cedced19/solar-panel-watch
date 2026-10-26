const assert = require('node:assert/strict');
const test = require('node:test');
const {createPowerWriter} = require('../lib/influx-lib');

function writer() {
  const points = [];
  const destinations = [];
  const errors = [];
  const api = createPowerWriter({
    config: {influx_org: 'test-org', influx_bucket: 'test-bucket', influx_default_tag: 'test-home'},
    client: {
      getWriteApi(org, bucket) {
        const destination = {org, bucket};
        destinations.push(destination);
        return {
          useDefaultTags(tags) { destination.tags = tags; },
          writePoint(point) { points.push(point); },
          close() { return Promise.resolve(); }
        };
      }
    },
    log() {},
    logError(error) { errors.push(error); }
  });
  return {api, points, destinations, errors};
}

function fields(point) {
  return Object.fromEntries(point.toLineProtocol().split(' ')[1].split(',').map(field => {
    const [name, value] = field.split('=');
    return [name, Number(value)];
  }));
}

test('stores Zendure house power and leaves missing solar as a gap in Influx history', async () => {
  const {api, points, destinations} = writer();
  await api.writePowerRaw(false, {housePowerSource: 'zendure', emeters: [{power: -350}, {power: null}]});
  assert.deepEqual(fields(points[0]), {power1: -350});
  assert.deepEqual(destinations, [{org: 'test-org', bucket: 'test-bucket', tags: {home: 'test-home'}}]);
});

test('network logging preserves finite solar metadata without attributing Shelly metadata to Zendure house', async () => {
  const {api, points} = writer();
  await api.writeNetworkData(false, {
    housePowerSource: 'zendure',
    emeters: [
      {power: -250, reactive: 99, pf: 0.8, voltage: 234},
      {power: 0, reactive: 3, pf: null, voltage: 230}
    ]
  });
  assert.deepEqual(fields(points[0]), {power1: -250, power2: 0, reactive2: 3, voltage2: 230});
});

test('both logging modes omit non-finite fields and avoid empty writes', async () => {
  const {api, points, destinations} = writer();
  await api.writePowerRaw(false, {emeters: [{power: Infinity}, {power: '20'}]});
  await api.writeNetworkData(false, {emeters: [{power: null, reactive: NaN, pf: undefined, voltage: -Infinity}, {power: null}]});
  await api.writePowerRaw(false, null);
  assert.deepEqual(points, []);
  assert.deepEqual(destinations, []);

  await api.writePowerRaw(false, {emeters: [{power: 0}, {power: NaN}]});
  assert.deepEqual(fields(points[0]), {power1: 0});
});

test('Shelly rollback still records finite network metadata from both meters', async () => {
  const {api, points} = writer();
  await api.writeNetworkData(false, {
    housePowerSource: 'shelly',
    emeters: [{power: -100, reactive: 1, pf: 0.8, voltage: 232}, {power: 100, reactive: 2, pf: 0.9, voltage: 231}]
  });
  assert.deepEqual(fields(points[0]), {
    power1: -100, reactive1: 1, pf1: 0.8, voltage1: 232,
    power2: 100, reactive2: 2, pf2: 0.9, voltage2: 231
  });
});
