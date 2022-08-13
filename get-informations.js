import { readFile } from 'fs/promises';
const config = JSON.parse(
  await readFile(
    new URL('./config.json', import.meta.url)
  )
);

import request from 'then-request';

function req(cb) {
  request('GET', 'http://' + config.ip_adress + '/status').done(function (res) {
    let data = JSON.parse(res.getBody('utf8')); 
    cb(null,{time: data.unixtime, emeters: data.emeters});
  });
}

export default req;
/*req(function (err, result) {
  console.log(result)
})*/