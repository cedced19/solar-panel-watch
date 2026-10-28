const assert = require('node:assert/strict');
const test = require('node:test');
const {createPowerWriter, createBatteryHistory, createSharedWriteApi} = require('../lib/victoria-lib');

const testConfig = {victoria_default_tag: 'test-home'};

// A shared writer that only collects the lines.
function fakeWrites() {
  const lines = [];
  return {lines, write(line) { lines.push(line); }, flush: async () => {}};
}

function writer() {
  const logs = [];
  const writes = fakeWrites();
  const api = createPowerWriter({
    config: testConfig,
    writes,
    now: () => 1780000000123,
    log(message) { logs.push(message); }
  });
  return {api, lines: writes.lines, logs};
}

function fields(line) {
  return Object.fromEntries(line.split(' ')[1].split(',').map(field => {
    const [name, value] = field.split('=');
    return [name, Number(value)];
  }));
}

test('stores Zendure house power and leaves missing solar as a gap in history', async () => {
  const {api, lines} = writer();
  await api.writePowerRaw(false, {housePowerSource: 'zendure', emeters: [{power: -350}, {power: null}]});
  assert.deepEqual(fields(lines[0]), {power1: -350});
  assert.equal(lines[0].split(' ')[0], 'power,home=test-home');
});

test('network logging preserves finite solar metadata without attributing Shelly metadata to Zendure house', async () => {
  const {api, lines} = writer();
  await api.writeNetworkData(false, {
    housePowerSource: 'zendure',
    emeters: [
      {power: -250, reactive: 99, pf: 0.8, voltage: 234},
      {power: 0, reactive: 3, pf: null, voltage: 230}
    ]
  });
  assert.deepEqual(fields(lines[0]), {power1: -250, power2: 0, reactive2: 3, voltage2: 230});
});

test('both logging modes omit non-finite fields and avoid empty writes', async () => {
  const {api, lines} = writer();
  await api.writePowerRaw(false, {emeters: [{power: Infinity}, {power: '20'}]});
  await api.writeNetworkData(false, {emeters: [{power: null, reactive: NaN, pf: undefined, voltage: -Infinity}, {power: null}]});
  await api.writePowerRaw(false, null);
  assert.deepEqual(lines, []);

  await api.writePowerRaw(false, {emeters: [{power: 0}, {power: NaN}]});
  assert.deepEqual(fields(lines[0]), {power1: 0});
});

test('Shelly rollback still records finite network metadata from both meters', async () => {
  const {api, lines} = writer();
  await api.writeNetworkData(false, {
    housePowerSource: 'shelly',
    emeters: [{power: -100, reactive: 1, pf: 0.8, voltage: 232}, {power: 100, reactive: 2, pf: 0.9, voltage: 231}]
  });
  assert.deepEqual(fields(lines[0]), {
    power1: -100, reactive1: 1, pf1: 0.8, voltage1: 232,
    power2: 100, reactive2: 2, pf2: 0.9, voltage2: 231
  });
});

test('a reading is stamped when it is polled, not when its batch is sent', async () => {
  const {api, lines, logs} = writer();
  await api.writePowerRaw(true, {emeters: [{power: -350}, {power: 20}]});
  assert.equal(lines[0], 'power,home=test-home power1=-350,power2=20 1780000000123');
  assert.deepEqual(logs, ['Data queued for VictoriaMetrics.']);
});

// A client whose writes succeed or fail as told, recording each batch.
function fakeClient() {
  const state = {batches: [], failures: []};
  state.client = {
    async write(lines) {
      state.batches.push(lines);
      const failure = state.failures.shift();
      if (failure) throw failure;
    }
  };
  return state;
}

test('readings are sent together after the flush interval, in one request', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const state = fakeClient();
  const writes = createSharedWriteApi({client: state.client, log() {}, logError() {}});
  writes.write('a f=1 1');
  writes.write('a f=2 2');
  t.mock.timers.tick(4999);
  await new Promise(setImmediate);
  assert.deepEqual(state.batches, []);
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  assert.deepEqual(state.batches, [['a f=1 1', 'a f=2 2']]);
});

test('a batch that cannot be sent is logged and sent again with the next one, an invalid one is dropped', async () => {
  const state = fakeClient();
  const logs = [];
  const errors = [];
  const writes = createSharedWriteApi({client: state.client, log(message) { logs.push(message); },
    logError(error) { errors.push(error); }});
  const down = Object.assign(new TypeError('fetch failed'), {});
  state.failures.push(down);
  writes.write('a f=1 1');
  await writes.flush();
  assert.deepEqual(logs, ['Failed at updating VictoriaMetrics: cannot connect to db.']);
  assert.deepEqual(errors, [down]);
  writes.write('a f=2 2');
  await writes.flush();
  assert.deepEqual(state.batches, [['a f=1 1'], ['a f=1 1', 'a f=2 2']]);

  const invalid = Object.assign(new Error('cannot parse'), {status: 400});
  state.failures.push(invalid);
  writes.write('bad');
  await writes.flush();
  assert.equal(logs.at(-1), 'VictoriaMetrics rejected a batch of readings, which is dropped.');
  await writes.flush();
  assert.equal(state.batches.length, 3, 'nothing left to send');
});

test('the buffer keeps the newest readings when VictoriaMetrics stays down', async () => {
  const state = fakeClient();
  const writes = createSharedWriteApi({client: state.client, log() {}, logError() {}, maxBufferedLines: 3});
  state.failures.push(new TypeError('fetch failed'));
  for (let i = 1; i <= 2; i++) writes.write('a f=' + i + ' ' + i);
  await writes.flush();
  for (let i = 3; i <= 5; i++) writes.write('a f=' + i + ' ' + i);
  await writes.flush();
  assert.deepEqual(state.batches.at(-1), ['a f=3 3', 'a f=4 4', 'a f=5 5']);
});

test('power and battery readings go through the same writer, which can be flushed', async () => {
  const state = fakeClient();
  const writes = createSharedWriteApi({client: state.client, log() {}, logError() {}});
  assert.equal(await writes.flush(), undefined, 'nothing to flush before the first write');
  assert.deepEqual(state.batches, []);
  const power = createPowerWriter({config: testConfig, writes, now: () => 1780000000123});
  const battery = createBatteryHistory({config: testConfig, writes, now: () => 1780000000123});
  await power.writePowerRaw(false, {emeters: [{power: 100}, {power: null}]});
  await battery.writeBatteryLevel(false, {socPercent: 50, time: 1770000123});
  await writes.flush();
  assert.deepEqual(state.batches, [[
    'power,home=test-home power1=100 1780000000123',
    'battery,home=test-home socPercent=50 1770000123000'
  ]]);
});
