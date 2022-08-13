

import express from 'express';
const app = express();
const port = 8889
import getInformations from './get-informations.js'

app.set('view engine', 'ejs');
app.use('/assets/', express.static('assets'));
app.get('/', function(req, res) {
    getInformations(function (err, data) {
        res.render('index', {
            power1: data.emeters[0].power,
            power2: data.emeters[1].power
        });
    })

});

app.listen(port, () => {
  console.log(`Solar panel watch launched on port ${port}`)
})