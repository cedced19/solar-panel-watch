const config = require('../config.json');

const request = require('then-request');

let save = null;
let last_save_time = 0;

function req(cb) {
  const req_time = (new Date()).getTime();
  if (save === null || Math.abs(last_save_time - req_time) >= config.shelly_req_threshold) {
    request('GET', 'http://' + config.ip_adress_shelly + '/status', {
      // Do not leave HTTP clients and the dashboard waiting for an unreachable Shelly.
      timeout: config.shelly_request_timeout || config.shelly_req_threshold
    }).done(function (res) {
      try {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          throw new Error('Shelly returned HTTP status ' + res.statusCode + '.');
        }
        let data = JSON.parse(res.getBody('utf8'));
        if (!Array.isArray(data.emeters) || data.emeters.length < 2) {
          throw new Error('Shelly response does not contain the expected power meters.');
        }
        save = {time: data.unixtime, emeters: data.emeters};
        cb(null,save);
        last_save_time = req_time;
      } catch (err) {
        save = null;
        cb(err);
        last_save_time = req_time;
      }
    }, function (err) {
      save = null;
      last_save_time = req_time;
      cb(err);
    });
  } else {
    cb(null,save);
  }
}
module.exports = { req: req };
