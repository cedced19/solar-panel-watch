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
    // Default is a 1 minute resolution; pages can override (e.g. raw for the
    // device debug plots) by setting window.currentDownsample before mounting.
    window.currentDownsample = '1m';

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
            parent.appendChild(wrap);
        }
        sel.value = window.currentDownsample;
        sel.onchange = function () {
            window.currentDownsample = sel.value;
            const loader = document.getElementById('loader');
            if (loader) loader.style.display = '';
            if (typeof reloadFn === 'function') reloadFn();
        };
    }

    // Responsive plot style: on narrow screens put the legend below the plot and
    // shrink the plot margins so the graph uses the available width, otherwise
    // keep the legend on the right with default spacing. Applied to every plot
    // on the graph pages that does not set its own legend/margin, and re-applied
    // live as the window is resized.
    function responsiveLegend() {
        if (window.innerWidth < 700) {
            return { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.35 };
        }
        return { orientation: 'v', x: 1, xanchor: 'right' };
    }

    function responsiveMargins() {
        if (window.innerWidth < 700) {
            // Reserve bottom space for the horizontal legend, slim sides/top.
            return { l: 50, r: 6, t: 24, b: 150 };
        }
        return { l: 70, r: 70, t: 50, b: 80 };
    }

    const originalNewPlot = Plotly.newPlot;
    Plotly.newPlot = function (target, data, layout, config) {
        if (layout) {
            if (!layout.legend) layout.legend = responsiveLegend();
            if (!layout.margin) layout.margin = responsiveMargins();
        }
        return originalNewPlot.call(this, target, data, layout, config);
    };

    function applyResponsiveStyle() {
        const plots = document.querySelectorAll('.js-plotly-plot');
        plots.forEach(function (el) {
            Plotly.relayout(el, { legend: responsiveLegend(), margin: responsiveMargins() });
        });
    }

    let resizeTimer = null;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(applyResponsiveStyle, 150);
    });

    window.parsePointsCSV = parsePointsCSV;
    window.fetchPointsCSV = fetchPointsCSV;
    window.attachDownsampleSelector = attachDownsampleSelector;
})();

