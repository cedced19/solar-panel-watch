const config = require('../config.json');

const request = require('then-request');

let save = {}; 
let last_save_time = 0;

function req(cb) {
  req_time = (new Date()).getTime();
  if (Math.abs(last_save_time - req_time) >= config.shelly_req_threshold) {
    request('GET', 'http://' + config.ip_adress_shelly + '/status').done(function (res) {
      try {
        let data = JSON.parse(res.getBody('utf8'));
        save = {time: data.unixtime, emeters: data.emeters};
        cb(null,save);
        last_save_time = req_time;
      } catch (err) {
        cb(err);
        last_save_time = req_time;
      }
      
    });
  } else {
    cb(null,save);
  }
}
module.exports = { req: req };
