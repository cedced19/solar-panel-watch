// Shared helper for fetching graph series as CSV instead of JSON and for
// selecting the downsampling scale on the graph pages.
// The server serves /api/data/power|var|... as CSV when passed ?format=csv and
// honours ?every=<duration> / ?raw=true on the power endpoint.

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

    // Current downsampling scale, e.g. 'auto' | '1m' | '5m' | '15m' | '30m' |
    // '1h' | 'raw'. Appended to power graph requests by fetchPointsCSV.
    window.currentDownsample = 'auto';

    function downsampleParams() {
        const v = window.currentDownsample || 'auto';
        if (v === 'auto') return '';
        if (v === 'raw') return '&raw=true';
        return '&every=' + encodeURIComponent(v);
    }

    // Fetch a points endpoint as CSV and resolve with an array of
    // { _time, _value } objects, identical to what response.json() returned.
    // The selected downsampling scale is applied to /api/data/power/* requests.
    function fetchPointsCSV(url) {
        const sep = url.indexOf('?') === -1 ? '?' : '&';
        let qs = 'format=csv';
        if (url.indexOf('/api/data/power/') !== -1) qs += downsampleParams();
        return fetch(url + sep + qs)
            .then(function (response) {
                return response.text();
            })
            .then(parsePointsCSV);
    }

    // Mount a small "Downsampling:" <select> above the graph and reload the page
    // graph through reloadFn every time the user changes the scale. Idempotent:
    // mounting twice simply re-wires the existing select.
    function attachDownsampleSelector(reloadFn) {
        let sel = document.getElementById('downsample-select');
        if (!sel) {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'text-align:center;padding:8px 0;';
            const label = document.createElement('label');
            label.style.cssText = 'font-family:sans-serif;font-size:14px;';
            label.textContent = 'Downsampling: ';
            sel = document.createElement('select');
            sel.id = 'downsample-select';
            ['auto', '1m', '5m', '15m', '30m', '1h', 'raw'].forEach(function (v) {
                const op = document.createElement('option');
                op.value = v;
                op.textContent = v === 'auto' ? 'Auto' : v === 'raw' ? 'Raw' : v;
                sel.appendChild(op);
            });
            label.appendChild(sel);
            wrap.appendChild(label);
            const graphs = document.getElementById('graphs-container');
            const parent = graphs ? graphs.parentNode : document.body;
            parent.insertBefore(wrap, graphs);
        }
        sel.value = window.currentDownsample;
        sel.onchange = function () {
            window.currentDownsample = sel.value;
            const loader = document.getElementById('loader');
            if (loader) loader.style.display = '';
            if (typeof reloadFn === 'function') reloadFn();
        };
    }

    window.parsePointsCSV = parsePointsCSV;
    window.fetchPointsCSV = fetchPointsCSV;
    window.attachDownsampleSelector = attachDownsampleSelector;
})();

