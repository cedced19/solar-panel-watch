// Views link their JS and CSS as asset('/assets/<file>'), which gives
// /assets/<file>?cache=<version>. The version is the start time of the app, so
// browsers fetch every file again after a restart instead of reusing a stale copy.
function createAssetUrl(version) {
    return url => url + '?cache=' + encodeURIComponent(version);
}

module.exports = {createAssetUrl};
