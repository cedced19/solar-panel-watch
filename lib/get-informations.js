const config = require('../config.json');

const request = require('then-request');

let save = {}; 
let last_save_time = 0;
let window = 3;
let moving_saves = [];

function add_moving_save(save) {
  if (moving_saves.length > window) {
    moving_saves.shift();
  }
  moving_saves.push(save);
}

function get_moving_save(cb) {
  req(function (err) {
    if (err) return cb(err);
    cb(null, moving_saves);
  });
}

function get_moving_average_power(emeter_number,cb) {
  get_moving_save(function (err, moving_saves) {
    if (err) return cb(err);
    let sum = 0;
    let power_list = [];
    for (let k in moving_saves) {
      sum += moving_saves[k].emeters[emeter_number].power;
      power_list.push(moving_saves[k].emeters[emeter_number].power)
    }
    cb(null, { list: power_list, average: sum/moving_saves.length });
  });
}

function req(cb) {
  req_time = (new Date()).getTime();
  if (Math.abs(last_save_time - req_time) >= config.shelly_req_thresold) {
    request('GET', 'http://' + config.ip_adress_shelly + '/status').done(function (res) {
      let data = JSON.parse(res.getBody('utf8'));
      save = {time: data.unixtime, emeters: data.emeters};
      add_moving_save(save);
      cb(null,save);
      last_save_time = req_time;
    });
  } else {
    cb(null,save);
  }
}

function update(debug) {
  req(function (err) {
    if (err) return console.log(err);
    if (debug) {
      console.log('Shelly requested.');
    }
  });
}

module.exports = { req: req, get_moving_save: get_moving_save, get_moving_average_power: get_moving_average_power, update: update };
