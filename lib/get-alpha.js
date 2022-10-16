const data = require('./data/alpha-power.json');

function findIndex(arr, value) {
    while (arr.length > 1) {
        m = Math.floor(arr.length/2);
        if (arr[m] >= value) {
            arr = arr.slice(0,m)
        } else {
            arr = arr.slice(m,arr.length)
        }
    }
    return data.indexOf(arr[0]);
}

function getAlpha(currentPower, limitPower) {
    let percentage_to_fit = currentPower/limitPower;
    if (percentage_to_fit > 1) {
        return 0;
    }
    if (percentage_to_fit < 0) {
        return 128;
    }
    return findIndex(data, percentage_to_fit, null);
}

module.exports = getAlpha;