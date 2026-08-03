const config = require('../config.json');
const request = require('then-request');
const {findShellyIpByMac, normalizeMacAddress} = require('./shelly-recovery');

const RECOVERY_RETRY_DELAY = 60000;

function createGetInformations(dependencies = {}) {
  const appConfig = dependencies.config || config;
  const requestFn = dependencies.requestFn || request;
  const recoveryFinder = dependencies.recoveryFinder || findShellyIpByMac;
  const requestTimeout = appConfig.shelly_request_timeout || appConfig.shelly_req_threshold;
  const recoveryTimeout = appConfig.shelly_recovery_timeout || 250;

  let save = null;
  let lastSaveTime = 0;
  let activeShellyIp = appConfig.ip_adress_shelly;
  let recoveredShellyIp = null;
  let recoveryNotFound = false;
  let recoveryPromise = null;
  let lastRecoveryAttempt = 0;

  function getRecoveryState() {
    return {
      attempted: lastRecoveryAttempt !== 0,
      enabled: appConfig.recover_shelly_through_mac_address === true,
      macAddress: appConfig.shelly_mac_address,
      notFound: recoveryNotFound,
      recoveredIp: recoveredShellyIp
    };
  }

  function requestStatus(ipAddress) {
    return Promise.resolve(requestFn('GET', 'http://' + ipAddress + '/status', {
      timeout: requestTimeout
    })).then(function (res) {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error('Shelly returned HTTP status ' + res.statusCode + '.');
      }
      const data = JSON.parse(res.getBody('utf8'));
      if (!Array.isArray(data.emeters) || data.emeters.length < 2) {
        throw new Error('Shelly response does not contain the expected power meters.');
      }
      return {time: data.unixtime, emeters: data.emeters};
    });
  }

  function recoverShellyIp() {
    const targetMacAddress = normalizeMacAddress(appConfig.shelly_mac_address);
    if (appConfig.recover_shelly_through_mac_address !== true || !targetMacAddress) {
      return Promise.resolve(null);
    }
    if (recoveryPromise !== null) {
      return recoveryPromise;
    }

    const now = Date.now();
    if (recoveryNotFound && now - lastRecoveryAttempt < RECOVERY_RETRY_DELAY) {
      return Promise.resolve(null);
    }

    lastRecoveryAttempt = now;
    recoveryPromise = Promise.resolve(recoveryFinder({
      ipAddress: appConfig.ip_adress_shelly,
      macAddress: targetMacAddress,
      requestFn,
      timeout: recoveryTimeout
    })).then(function (ipAddress) {
      recoveryNotFound = !ipAddress;
      if (ipAddress) {
        activeShellyIp = ipAddress;
        recoveredShellyIp = ipAddress === appConfig.ip_adress_shelly ? null : ipAddress;
      }
      return ipAddress;
    }).catch(function () {
      recoveryNotFound = true;
      return null;
    }).finally(function () {
      recoveryPromise = null;
    });

    return recoveryPromise;
  }

  function req(cb) {
    const requestTime = Date.now();
    if (save !== null && Math.abs(lastSaveTime - requestTime) < appConfig.shelly_req_threshold) {
      cb(null, save);
      return;
    }

    requestStatus(activeShellyIp).then(function (data) {
      save = data;
      lastSaveTime = requestTime;
      recoveryNotFound = false;
      cb(null, save);
    }).catch(function (requestError) {
      save = null;
      lastSaveTime = requestTime;
      recoverShellyIp().then(function (recoveredIpAddress) {
        if (!recoveredIpAddress) {
          cb(requestError);
          return;
        }
        requestStatus(recoveredIpAddress).then(function (data) {
          save = data;
          lastSaveTime = requestTime;
          recoveryNotFound = false;
          cb(null, save);
        }).catch(function (recoveredRequestError) {
          save = null;
          cb(recoveredRequestError);
        });
      });
    });
  }

  return {req, getRecoveryState};
}

const client = createGetInformations();

module.exports = {
  req: client.req,
  getRecoveryState: client.getRecoveryState,
  createGetInformations
};
