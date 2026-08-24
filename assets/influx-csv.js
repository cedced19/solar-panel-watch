// Shared helper for fetching graph series as CSV instead of JSON.
// The server serves /api/data/power|var|... as CSV when passed ?format=csv.
// Parsing a flat "_time,_value\n..." series is faster and lighter than JSON.
(function () {
    function parsePointsCSV(text) {
        const lines = text.split('\n');
        const out = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            const comma = line.indexOf(',');
            if (comma === -1) continue;
            out.push({
                _time: line.substring(0, comma),
                _value: Number(line.substring(comma + 1))
            });
        }
        return out;
    }

    // Fetch a points endpoint as CSV and resolve with an array of
    // { _time, _value } objects, identical to what response.json() returned.
    function fetchPointsCSV(url) {
        const sep = url.indexOf('?') === -1 ? '?' : '&';
        return fetch(url + sep + 'format=csv')
            .then(function (response) {
                return response.text();
            })
            .then(parsePointsCSV);
    }

    window.parsePointsCSV = parsePointsCSV;
    window.fetchPointsCSV = fetchPointsCSV;
})();
