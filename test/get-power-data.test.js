const assert = require('node:assert/strict');
const test = require('node:test');
const {createGetPowerData} = require('../lib/get-power-data');

function power(client) {
  return new Promise((resolve, reject) => client.req((error, data) => error ? reject(error) : resolve(data)));
}

function battery(client) {
  return new Promise((resolve, reject) => client.reqBattery((error, data) => error ? reject(error) : resolve(data)));
}

function success(data, method = 'req') {
  return {[method]: callback => callback(null, data)};
}

test('starts both sources together, coalesces callers, and uses Zendure exclusively for house power', async () => {
  const starts = [];
  let shellyCallback;
  let meterCallback;
  const client = createGetPowerData({
    config: {},
    shellyClient: {req(callback) { starts.push('shelly'); shellyCallback = callback; }},
    meterClient: {reqPower(callback) { starts.push('zendure'); meterCallback = callback; }}
  });
  const first = power(client);
  const second = power(client);
  assert.deepEqual(starts, ['shelly', 'zendure']);
  meterCallback(null, {power: -430, time: 1760000000});
  const solar = {power: 850, reactive: 2, pf: 0.9, voltage: 230};
  shellyCallback(null, {
    time: 1750000000,
    emeters: [{power: 999, reactive: 14, pf: 0.7, voltage: 231}, solar]
  });
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(a, b);
  assert.deepEqual(a, {
    time: 1760000000,
    emeters: [{power: -430}, solar],
    housePowerSource: 'zendure'
  });
});

test('synchronous source callbacks still start both requests before returning a result', async () => {
  const starts = [];
  const client = createGetPowerData({
    config: {},
    shellyClient: {req(callback) { starts.push('shelly'); callback(null, {emeters: [{power: 10}, {power: 20}]}); }},
    meterClient: {reqPower(callback) { starts.push('zendure'); callback(null, {power: 30}); }}
  });
  await new Promise((resolve, reject) => client.req((error, data) => {
    if (error) return reject(error);
    assert.deepEqual(starts, ['shelly', 'zendure']);
    assert.equal(data.emeters[0].power, 30);
    resolve();
  }));
});

test('Shelly failure leaves solar unavailable while Zendure house power remains usable', async () => {
  const client = createGetPowerData({
    config: {},
    shellyClient: {req: callback => callback(new Error('Shelly offline'))},
    meterClient: success({power: 0, time: 3}, 'reqPower')
  });
  const data = await power(client);
  assert.equal(data.emeters[0].power, 0);
  assert.deepEqual(data.emeters[1], {power: null});
});

test('missing or invalid solar power remains unavailable instead of becoming zero', async () => {
  for (const solar of [null, {}, {power: null}, {power: '0'}, {power: Infinity}, {power: NaN}]) {
    const client = createGetPowerData({
      config: {},
      shellyClient: success({emeters: [{power: 500}, solar]}),
      meterClient: success({power: -25}, 'reqPower')
    });
    assert.deepEqual((await power(client)).emeters[1], {power: null});
  }
});

test('a slow Shelly recovery cannot block house requests or start duplicate Shelly requests', async () => {
  let shellyCalls = 0;
  let meterCalls = 0;
  const client = createGetPowerData({
    config: {shelly_req_threshold: 20},
    shellyClient: {req() { shellyCalls++; }},
    meterClient: {reqPower(callback) { meterCalls++; callback(null, {power: -300}); }}
  });
  const first = await power(client);
  const second = await power(client);
  assert.deepEqual(first.emeters[1], {power: null});
  assert.deepEqual(second.emeters[1], {power: null});
  assert.equal(meterCalls, 2);
  assert.equal(shellyCalls, 1);
});

test('Zendure failure is returned promptly without awaiting Shelly or falling back to its house reading', async () => {
  const failure = new Error('Zendure offline');
  const client = createGetPowerData({
    config: {shelly_req_threshold: 100000},
    shellyClient: {req() {}},
    meterClient: {reqPower: callback => callback(failure)}
  });
  await assert.rejects(power(client), error => error === failure);

  const withHealthyShelly = createGetPowerData({
    config: {},
    shellyClient: success({emeters: [{power: -999}, {power: 200}]}),
    meterClient: {reqPower: callback => callback(failure)}
  });
  await assert.rejects(power(withHealthyShelly), error => error === failure);
});

test('invalid Zendure house readings fail closed even when Shelly has a valid house value', async () => {
  for (const value of [undefined, null, '20', NaN, Infinity, -Infinity]) {
    const client = createGetPowerData({
      config: {},
      shellyClient: success({emeters: [{power: -999}, {power: 200}]}),
      meterClient: success({power: value}, 'reqPower')
    });
    await assert.rejects(power(client), /finite house power/);
  }
});

test('an explicit Shelly source supports rollback and validates its house channel', async () => {
  const client = createGetPowerData({
    config: {house_power_source: 'shelly', shelly_req_threshold: 750},
    shellyClient: success({time: 123, emeters: [{power: -150, voltage: 230}, {power: 200}]}),
    meterClient: {reqPower() { throw new Error('Zendure should not be requested'); }}
  });
  assert.equal(client.getHousePowerSource(), 'shelly');
  assert.equal(client.powerRequestThreshold, 750);
  assert.deepEqual(await power(client), {
    time: 123,
    emeters: [{power: -150, voltage: 230}, {power: 200}],
    housePowerSource: 'shelly'
  });
  const invalid = createGetPowerData({
    config: {house_power_source: 'shelly'},
    shellyClient: success({emeters: [{power: null}, {power: 200}]})
  });
  await assert.rejects(power(invalid), /finite house power/);
  assert.throws(() => createGetPowerData({config: {house_power_source: 'automatic'}}), /house_power_source/);
});

test('maps configured Zendure device options and keeps battery polling on its separate threshold', async () => {
  const options = [];
  const batteryData = {socPercent: 72, socSource: 'packData.socLevel', state: 'charging', time: 10};
  const client = createGetPowerData({
    config: {
      zendure_req_threshold: 1500,
      zendure_battery_req_threshold: 20000,
      zendure_request_timeout: 3500,
      zendure_meter: {host: '192.168.0.48', serial: 'METER', mac_address: 'E0:72:A1:85:24:4B', wlan_mac_address: 'E0:72:A1:85:24:48', recover_by_mac: true, power_field: 'total_power', power_scale: -1},
      zendure_battery: {host: '192.168.0.40', serial: 'HUB', battery_serial: 'PACK', mac_address: '90:64:9B:10:9A:14', recover_by_mac: true}
    },
    shellyClient: success({emeters: [{power: 999}, {power: 200}]}),
    zendureClientFactory(deviceOptions) {
      options.push(deviceOptions);
      return deviceOptions.serial === 'METER' ? success({power: -500}, 'reqPower') : success(batteryData, 'reqBattery');
    }
  });
  await power(client);
  assert.strictEqual(await battery(client), batteryData);
  assert.deepEqual(options, [
    {host: '192.168.0.48', serial: 'METER', batterySerial: undefined, macAddress: 'E0:72:A1:85:24:4B', wlanMacAddress: 'E0:72:A1:85:24:48', recoverByMac: true, requestThreshold: 1500, timeout: 3500, powerField: 'total_power', powerScale: -1},
    {host: '192.168.0.40', serial: 'HUB', batterySerial: 'PACK', macAddress: '90:64:9B:10:9A:14', wlanMacAddress: undefined, recoverByMac: true, requestThreshold: 20000, timeout: 3500, powerField: undefined, powerScale: undefined}
  ]);
  assert.equal(client.powerRequestThreshold, 1500);
  assert.equal(client.batteryRequestThreshold, 20000);
});

test('uses defaults and exposes recovery states for the selected house, solar and battery sources', () => {
  const meterState = {recoveredIp: '192.168.0.49'};
  const shellyState = {notFound: true};
  const batteryState = {recoveredIp: '192.168.0.41'};
  const client = createGetPowerData({
    config: {},
    meterClient: {getRecoveryState: () => meterState},
    shellyClient: {getRecoveryState: () => shellyState},
    batteryClient: {getRecoveryState: () => batteryState}
  });
  assert.equal(client.getHousePowerSource(), 'zendure');
  assert.equal(client.powerRequestThreshold, 1000);
  assert.equal(client.batteryRequestThreshold, 20000);
  assert.strictEqual(client.getHouseRecoveryState(), meterState);
  assert.strictEqual(client.getShellyRecoveryState(), shellyState);
  assert.strictEqual(client.getBatteryRecoveryState(), batteryState);
});
