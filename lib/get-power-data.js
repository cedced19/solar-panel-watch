const config = require('../config.json');
const shelly = require('./get-informations');
const {createZendureClient} = require('./zendure');

function positiveMilliseconds(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createGetPowerData(dependencies = {}) {
  const appConfig = dependencies.config || config;
  const shellyClient = dependencies.shellyClient || shelly;
  const zendureClientFactory = dependencies.zendureClientFactory || createZendureClient;
  const housePowerSource = appConfig.house_power_source === undefined ? 'zendure' : appConfig.house_power_source;
  if (housePowerSource !== 'zendure' && housePowerSource !== 'shelly') {
    throw new Error('house_power_source must be "zendure" or "shelly".');
  }

  const zendureRequestThreshold = positiveMilliseconds(appConfig.zendure_req_threshold, 1000);
  const batteryRequestThreshold = positiveMilliseconds(appConfig.zendure_battery_req_threshold, 20000);
  const requestTimeout = positiveMilliseconds(appConfig.zendure_request_timeout, 3000);
  const powerRequestThreshold = housePowerSource === 'zendure' ? zendureRequestThreshold :
    positiveMilliseconds(appConfig.shelly_req_threshold, 1000);
  // Shelly recovery can scan the network. Keep that work shared and in the
  // background once its normal request timeout has elapsed.
  const solarTimeout = Math.min(1000, powerRequestThreshold,
    positiveMilliseconds(appConfig.shelly_request_timeout,
      positiveMilliseconds(appConfig.shelly_req_threshold, 1000)));

  let meterClient = dependencies.meterClient;
  let batteryClient = dependencies.batteryClient;
  let shellyRequest = null;
  let pendingCallbacks = null;

  function zendureOptions(deviceConfig, threshold) {
    const device = deviceConfig || {};
    return {
      host: device.host,
      serial: device.serial,
      batterySerial: device.battery_serial,
      macAddress: device.mac_address,
      wlanMacAddress: device.wlan_mac_address,
      recoverByMac: device.recover_by_mac === true,
      requestThreshold: threshold,
      timeout: requestTimeout,
      powerField: device.power_field,
      powerScale: device.power_scale
    };
  }

  function getMeterClient() {
    if (!meterClient) {
      meterClient = zendureClientFactory(zendureOptions(appConfig.zendure_meter, zendureRequestThreshold));
    }
    return meterClient;
  }

  function getBatteryClient() {
    if (!batteryClient) {
      batteryClient = zendureClientFactory(zendureOptions(appConfig.zendure_battery, batteryRequestThreshold));
    }
    return batteryClient;
  }

  // Always resolve an outcome, including synchronous client/configuration
  // errors, so both power requests can start before results are handled.
  function readClient(getClient, method) {
    return new Promise((resolve) => {
      try {
        getClient()[method]((error, data) => resolve({error, data}));
      } catch (error) {
        resolve({error});
      }
    });
  }

  function readShelly() {
    if (!shellyRequest) {
      shellyRequest = readClient(() => shellyClient, 'req').then((outcome) => {
        shellyRequest = null;
        return outcome;
      });
    }
    return shellyRequest;
  }

  function boundedSolarRequest(request) {
    let complete;
    const promise = new Promise((resolve) => { complete = resolve; });
    const timer = setTimeout(() => complete({error: new Error('Shelly solar request timed out.')}), solarTimeout);
    request.then((outcome) => {
      clearTimeout(timer);
      complete(outcome);
    });
    return {
      promise,
      cancel() {
        clearTimeout(timer);
        complete({error: new Error('House power request failed.')});
      }
    };
  }

  function solarMeter(outcome) {
    const meter = !outcome.error && outcome.data && Array.isArray(outcome.data.emeters) && outcome.data.emeters[1];
    return meter && Number.isFinite(meter.power) ? {...meter} : {power: null};
  }

  function finish(error, data) {
    const callbacks = pendingCallbacks;
    pendingCallbacks = null;
    callbacks.forEach((callback) => callback(error, data));
  }

  function req(callback) {
    if (pendingCallbacks) {
      pendingCallbacks.push(callback);
      return;
    }
    pendingCallbacks = [callback];

    const shellyResult = readShelly();
    if (housePowerSource === 'shelly') {
      shellyResult.then((outcome) => {
        if (outcome.error) return finish(outcome.error);
        const house = outcome.data && Array.isArray(outcome.data.emeters) && outcome.data.emeters[0];
        if (!house || !Number.isFinite(house.power)) {
          return finish(new Error('Shelly response does not contain a finite house power value.'));
        }
        finish(null, {
          time: outcome.data.time,
          emeters: [{...house}, solarMeter(outcome)],
          housePowerSource
        });
      });
      return;
    }

    const solarResult = boundedSolarRequest(shellyResult);
    readClient(getMeterClient, 'reqPower').then((outcome) => {
      if (outcome.error || !outcome.data || !Number.isFinite(outcome.data.power)) {
        solarResult.cancel();
        return finish(outcome.error || new Error('Zendure response does not contain a finite house power value.'));
      }
      solarResult.promise.then((solar) => finish(null, {
        time: outcome.data.time,
        emeters: [{power: outcome.data.power}, solarMeter(solar)],
        housePowerSource
      }));
    });
  }

  function reqBattery(callback) {
    try {
      getBatteryClient().reqBattery(callback);
    } catch (error) {
      callback(error);
    }
  }

  function reqBatterySettings(callback) {
    try {
      getBatteryClient().reqBatterySettings(callback);
    } catch (error) {
      callback(error);
    }
  }

  // The Zendure house power sensor on its own, whatever the configured house power source.
  function reqMeter(callback) {
    try {
      getMeterClient().reqPower(callback);
    } catch (error) {
      callback(error);
    }
  }

  // The Shelly status on its own; it shares the request with req().
  function reqShelly(callback) {
    readShelly().then(({error, data}) => callback(error || null, data));
  }

  function recoveryState(client) {
    return client && typeof client.getRecoveryState === 'function' ? client.getRecoveryState() : {};
  }

  return {
    req,
    reqBattery,
    reqBatterySettings,
    reqMeter,
    reqShelly,
    getHousePowerSource: () => housePowerSource,
    getHouseRecoveryState: () => recoveryState(housePowerSource === 'zendure' ? meterClient : shellyClient),
    getShellyRecoveryState: () => recoveryState(shellyClient),
    getBatteryRecoveryState: () => recoveryState(batteryClient),
    powerRequestThreshold,
    batteryRequestThreshold
  };
}

module.exports = {...createGetPowerData(), createGetPowerData};
