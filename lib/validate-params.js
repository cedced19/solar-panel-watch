// Validation of duration parameters (e.g. "30s", "1m", "24h", "7d", "2w", "1y").
const PERIOD_REGEX = /^\d{1,4}(s|m|h|d|w|y)$/;
const UNIT_MS = {s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 86400 * 1000, w: 7 * 86400 * 1000, y: 365 * 86400 * 1000};

function isValidPeriod(period) {
    return typeof period === 'string' && PERIOD_REGEX.test(period);
}

// Milliseconds of a duration like "24h" (a year counts 365 days).
function periodToMs(period) {
    return parseInt(period, 10) * UNIT_MS[period.slice(-1)];
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
    periodToMs,
    validatePeriod,
    validateGroup
};
