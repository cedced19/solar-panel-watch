const assert = require('node:assert/strict');
const test = require('node:test');
const {createPowerWriter, createBatteryHistory, createSharedWriteApi} = require('../lib/influx-lib');

const testConfig = {influx_org: 'test-org', influx_bucket: 'test-bucket', influx_default_tag: 'test-home'};

// A client whose write API only buffers: nothing is sent until flush().
function fakeClient() {
  const state = {points: [], destinations: [], options: [], flushes: []};
  state.client = {
    getWriteApi(org, bucket, precision, options) {
      const destination = {org, bucket};
      state.destinations.push(destination);
      state.options.push({precision, ...options});
      return {
        useDefaultTags(tags) { destination.tags = tags; },
        writePoint(point) { state.points.push(point); },
        flush(withRetries) { state.flushes.push(withRetries); return Promise.resolve(); }
      };
    }
  };
  return state;
}

function writer() {
  const errors = [];
  const logs = [];
  const state = fakeClient();
  const api = createPowerWriter({
    config: testConfig,
    client: state.client,
    now: () => 1780000000123,
    log(message) { logs.push(message); },
    logError(error) { errors.push(error); }
  });
  return {api, points: state.points, destinations: state.destinations, errors, logs, state};
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

test('a reading is stamped when it is polled, not when its batch is sent', async () => {
  const {api, points} = writer();
  await api.writePowerRaw(false, {emeters: [{power: -350}, {power: 20}]});
  assert.equal(points[0].toLineProtocol(), 'power power1=-350,power2=20 1780000000123000000');
});

test('all writes share one buffered write API, sent every few seconds and retried by the client', async () => {
  const {api, state, logs, errors} = writer();
  for (let i = 0; i < 5; i++) await api.writePowerRaw(true, {emeters: [{power: i}, {power: null}]});
  assert.equal(state.points.length, 5);
  assert.deepEqual(state.destinations, [{org: 'test-org', bucket: 'test-bucket', tags: {home: 'test-home'}}]);
  assert.equal(state.options.length, 1);
  assert.equal(state.options[0].precision, 'ns');
  assert.ok(state.options[0].flushInterval >= 5000 && state.options[0].flushInterval <= 10000);
  assert.deepEqual(logs, Array(5).fill('Data queued for InfluxDB.'));

  // A failed batch is logged by the client's callback, once per attempt.
  const failure = new Error('InfluxDB unavailable');
  state.options[0].writeFailed(failure, [], 1, 0);
  assert.deepEqual(logs.at(-1), 'Failed at updating InfluxDB: cannot connect to db.');
  assert.deepEqual(errors, [failure]);
});

test('a write API that cannot start is logged and does not reject the caller', async () => {
  const failure = new Error('cannot start');
  const errors = [];
  const api = createPowerWriter({
    config: testConfig, now: () => 0, log() {}, logError(error) { errors.push(error); },
    client: {getWriteApi() { throw failure; }}
  });
  await assert.doesNotReject(api.writePowerRaw(false, {emeters: [{power: 1}, {power: null}]}));
  assert.deepEqual(errors, [failure]);
});

test('power and battery readings go through the same write API, which can be flushed', async () => {
  const state = fakeClient();
  const writes = createSharedWriteApi({client: state.client, config: testConfig, log() {}, logError() {}});
  assert.equal(await writes.flush(), undefined, 'nothing to flush before the first write');
  assert.deepEqual(state.flushes, []);
  const power = createPowerWriter({config: testConfig, writes, now: () => 1780000000123});
  const battery = createBatteryHistory({config: testConfig, writes, now: () => 1780000000123});
  await power.writePowerRaw(false, {emeters: [{power: 100}, {power: null}]});
  await battery.writeBatteryLevel(false, {socPercent: 50, time: 1770000123});
  assert.equal(state.destinations.length, 1);
  assert.deepEqual(state.points.map(point => point.toLineProtocol().split(' ')[0]), ['power', 'battery']);
  await writes.flush();
  assert.deepEqual(state.flushes, [true], 'also sends the batches waiting for a retry');
});
