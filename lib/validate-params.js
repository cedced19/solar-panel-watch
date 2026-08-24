// Validation of Influx-style duration parameters (e.g. "30s", "1m", "24h", "7d", "2w", "1y").
const PERIOD_REGEX = /^\d{1,4}(s|m|h|d|w|y)$/;

function isValidPeriod(period) {
    return typeof period === 'string' && PERIOD_REGEX.test(period);
}

function validatePeriod(req, res, next) {
    if (!isValidPeriod(req.params.period)) {
        const err = new Error('Invalid "period" parameter. Expected a duration like "30s", "1m", "24h", "7d", "2w" or "1y".');
        err.status = 400;
        return next(err);
    }
    next();
}

function validateGroup(req, res, next) {
    if (!isValidPeriod(req.params.group)) {
        const err = new Error('Invalid "group" parameter. Expected a duration like "1m", "5m" or "1h".');
        err.status = 400;
        return next(err);
    }
    next();
}

module.exports = {
    isValidPeriod,
    validatePeriod,
    validateGroup
};
