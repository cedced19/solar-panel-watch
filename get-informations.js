const config = require('./config.json');

const request = require('then-request');

function req(cb) {
  request('GET', 'http://' + config.ip_adress + '/status').done(function (res) {
    let data = JSON.parse(res.getBody('utf8')); 
    cb(null,{time: data.unixtime, emeters: data.emeters});
  });
}

module.exports = req;
/*req(function (err, result) {
  console.log(result)
})*/