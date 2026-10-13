// Both household graphs use the same time-aligned balance computed by the
// server. Missing battery readings stay as component gaps; household totals
// use grid and solar alone when the battery adjustment is unavailable.
(function () {
    const page = document.getElementById('consumption-power-page');
    const loader = document.getElementById('loader');
    const graph = document.getElementById('graphs-container');
    const status = document.getElementById('consumption-power-status');
    const devices = JSON.parse(page.dataset.devices || '[]');
    const deviceColors = ['#3d3d3d', '#ff9f1a', '#cd84f1', '#01a3a4', '#e66767', '#546de5'];
    const series = [
        {field: 'power1', label: page.dataset.networkLabel, color: '#c0392b'},
        {field: 'power2', label: page.dataset.solarLabel, color: '#2ecc71'},
        {field: 'battery_discharging', label: page.dataset.dischargingLabel, color: '#8e44ad'},
        {field: 'battery_charging', label: page.dataset.chargingLabel, color: '#d97706', dash: 'dash'},
        {field: 'house_consumption', label: page.dataset.totalLabel, color: '#2980b9'}
    ];
    let requestId = 0;

    function downsampleQuery() {
        const every = window.currentDownsample || 'auto';
        if (every === 'auto') return '';
        return every === 'raw' ? 'raw=true' : 'every=' + encodeURIComponent(every);
    }

    function consumptionURL() {
        const query = downsampleQuery();
        return '/api/data/consumption/' + encodeURIComponent(page.dataset.period) + (query ? '?' + query : '');
    }

    async function fetchDevicePoints(device) {
        const query = downsampleQuery();
        const url = '/api/data/power/' + encodeURIComponent(device) + '/' + encodeURIComponent(page.dataset.period) +
            '?format=csv' + (query ? '&' + query : '');
        const response = await fetch(url);
        if (!response.ok) throw new Error('Device history request failed: ' + response.status);
        return parsePointsCSV(await response.text());
    }

    // Plotly expects wall-clock dates for the configured zone, independently
    // of the timezone selected by the browser.
    function plotTime(timestamp, formatter) {
        const parts = {};
        const date = new Date(timestamp);
        formatter.formatToParts(date).forEach(function (part) { parts[part.type] = part.value; });
        return parts.year + '-' + parts.month + '-' + parts.day + 'T' +
            parts.hour + ':' + parts.minute + ':' + parts.second + '.' +
            String(date.getUTCMilliseconds()).padStart(3, '0');
    }

    function trace(points, spec, formatter) {
        const validPoints = points.filter(function (point) {
            return point && typeof point._time === 'string' && Number.isFinite(Date.parse(point._time));
        }).sort(function (first, second) { return Date.parse(first._time) - Date.parse(second._time); });
        const values = validPoints.map(function (point) {
            return Number.isFinite(point._value) ? point._value : null;
        });
        const isolated = values.some(function (value, index) {
            return value !== null && (index === 0 || values[index - 1] === null) &&
                (index === values.length - 1 || values[index + 1] === null);
        });
        return {
            type: 'scatter', mode: isolated ? 'lines+markers' : 'lines', name: spec.label,
            x: validPoints.map(function (point) { return plotTime(Date.parse(point._time), formatter); }),
            y: values, line: {color: spec.color, dash: spec.dash || 'solid', shape: spec.shape || 'linear'},
            connectgaps: false,
            hovertemplate: '%{x|%Y-%m-%d %H:%M:%S}<br>%{y:.1f} W<extra>%{fullData.name}</extra>'
        };
    }

    function prettyName(name) {
        return name.replaceAll('-', ' ').split(' ').map(function (word) {
            return word ? word[0].toUpperCase() + word.substring(1) : '';
        }).join(' ');
    }

    async function loadData() {
        const currentRequest = ++requestId;
        loader.style.display = '';
        graph.hidden = true;
        status.hidden = true;
        page.setAttribute('aria-busy', 'true');
        try {
            const balanceRequest = fetch(consumptionURL(), {cache: 'no-store'}).then(async function (response) {
                if (!response.ok) throw new Error('Power history request failed: ' + response.status);
                const balance = await response.json();
                if (!balance || !series.every(function (spec) { return Array.isArray(balance[spec.field]); })) {
                    throw new Error('Invalid power balance response.');
                }
                return balance;
            });
            const results = await Promise.all([balanceRequest].concat(devices.map(function (device) {
                return fetchDevicePoints(device);
            })));
            if (currentRequest !== requestId) return;
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: page.dataset.timezone,
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
            });
            const traces = series.map(function (spec) { return trace(results[0][spec.field], spec, formatter); });
            devices.forEach(function (device, index) {
                traces.splice(traces.length - 1, 0, trace(results[index + 1], {
                    label: prettyName(device), color: deviceColors[index % deviceColors.length], shape: 'hv'
                }, formatter));
            });
            if (!traces.some(function (item) { return item.x.length > 0; })) {
                status.textContent = page.dataset.emptyLabel;
                status.hidden = false;
                return;
            }
            if (!traces[traces.length - 1].y.some(Number.isFinite)) {
                status.textContent = page.dataset.totalUnavailableLabel;
                status.hidden = false;
            }
            graph.hidden = false;
            await Plotly.newPlot(graph, traces, {
                title: page.dataset.title,
                autosize: true,
                height: Math.max(window.innerHeight * 0.7, 420),
                xaxis: {type: 'date', title: page.dataset.timeLabel + ' (' + page.dataset.timezone + ')'},
                yaxis: {title: page.dataset.powerLabel, ticksuffix: ' W'}
            }, {responsive: true, displaylogo: false});
        } catch (error) {
            if (currentRequest !== requestId) return;
            graph.hidden = true;
            status.textContent = page.dataset.errorLabel;
            status.hidden = false;
        } finally {
            if (currentRequest === requestId) {
                loader.style.display = 'none';
                page.setAttribute('aria-busy', 'false');
            }
        }
    }

    window.addEventListener('load', loadData);
    attachDownsampleSelector(loadData);
})();
