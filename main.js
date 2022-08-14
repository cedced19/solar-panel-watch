

import express from 'express';
const app = express();
const port = 8889
import getInformations from './get-informations.js'

app.set('view engine', 'ejs');
app.use('/assets/', express.static('assets'));

app.get('/', function(req, res) {
    getInformations(function (err, data) {
        if (err) return next(err);
        res.render('index', {
            power1: data.emeters[0].power,
            power2: data.emeters[1].power
        });
    });
});

app.use(function (req, res, next) {
    var err = new Error('Element cannot be find.');
    res.status(404);
    next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use(function (err, req, res, next) {
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            status: err.status || 500,
            error: err
        });
    });
}

// production error handler
// no stacktraces leaked to user
app.use(function (err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        status: err.status || 500, 
        error: {}
    });
});


app.listen(port, () => {
  console.log(`Solar panel watch launched on port ${port}`)
})