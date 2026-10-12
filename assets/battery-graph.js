(function () {
    const page = document.getElementById('battery-history-page');
    const loader = document.getElementById('loader');
    const graphCard = document.getElementById('battery-graph-card');
    const graph = document.getElementById('graphs-container');
    const status = document.getElementById('battery-graph-status');
    const message = document.getElementById('battery-graph-message');
    const retry = document.getElementById('battery-graph-retry');
    const powerSeries = [
        {field: 'outputHomePower', label: page.dataset.homePowerLabel, color: '#16a34a', dash: 'solid'},
        {field: 'gridInputPower', label: page.dataset.gridPowerLabel, color: '#9333ea', dash: 'dash'},
        {field: 'outputPackPower', label: page.dataset.chargingPowerLabel, color: '#d97706', dash: 'dot'},
        {field: 'packInputPower', label: page.dataset.dischargingPowerLabel, color: '#dc2626', dash: 'dashdot'}
    ];
    let requestPending = false;

    function validSoc(value) {
        return Number.isFinite(value) && value >= 0 && value <= 100;
    }

    function validPower(value) {
        return Number.isFinite(value) && value >= 0;
    }

    function traceMode(values) {
        // Keep isolated readings visible when unavailable samples split a line.
        return values.some(function (value, index) {
            return value !== null && (index === 0 || values[index - 1] === null) &&
                (index === values.length - 1 || values[index + 1] === null);
        }) ? 'lines+markers' : 'lines';
    }

    function showStatus(label) {
        message.textContent = label;
        status.hidden = false;
        graphCard.hidden = true;
    }

    // Plotly's date axis uses wall-clock values. Format in the configured zone,
    // independently of the browser's timezone, and retain fractional seconds.
    function plotTime(timestamp, formatter) {
        const parts = {};
        formatter.formatToParts(new Date(timestamp)).forEach(function (part) {
            parts[part.type] = part.value;
        });
        const milliseconds = String(new Date(timestamp).getUTCMilliseconds()).padStart(3, '0');
        return parts.year + '-' + parts.month + '-' + parts.day + 'T' +
            parts.hour + ':' + parts.minute + ':' + parts.second + '.' + milliseconds;
    }

    async function loadData() {
        if (requestPending) return;
        requestPending = true;
        retry.disabled = true;
        loader.hidden = false;
        status.hidden = true;
        graphCard.hidden = true;
        page.setAttribute('aria-busy', 'true');

        try {
            const response = await fetch('/api/data/battery/' + encodeURIComponent(page.dataset.period), {cache: 'no-store'});
            if (!response.ok) throw new Error('Battery history request failed: ' + response.status);
            const data = await response.json();
            if (!Array.isArray(data)) throw new Error('Invalid battery history response.');
            if (data.length === 0) {
                showStatus(page.dataset.emptyLabel);
                return;
            }
            const points = data.filter(function (point) {
                return point && typeof point._time === 'string' && Number.isFinite(Date.parse(point._time)) &&
                    (validSoc(point._value) || powerSeries.some(function (series) {
                        return validPower(point[series.field]);
                    }));
            }).sort(function (first, second) {
                return Date.parse(first._time) - Date.parse(second._time);
            });
            if (points.length === 0) throw new Error('Battery history has no valid readings.');

            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: page.dataset.timezone,
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
            });
            const timestamps = points.map(function (point) { return plotTime(Date.parse(point._time), formatter); });
            const socValues = points.map(function (point) { return validSoc(point._value) ? point._value : null; });
            const traces = [{
                type: 'scatter',
                mode: traceMode(socValues),
                name: page.dataset.socLabel,
                x: timestamps,
                y: socValues,
                line: {color: '#2563eb', width: 3},
                connectgaps: false,
                hovertemplate: '%{x|%Y-%m-%d %H:%M:%S}<br>%{y:.1f}%<extra>%{fullData.name}</extra>'
            }];
            powerSeries.forEach(function (series) {
                const values = points.map(function (point) {
                    return validPower(point[series.field]) ? point[series.field] : null;
                });
                const readingCount = values.filter(function (value) { return value !== null; }).length;
                // Old history and unsupported properties have no power samples.
                if (readingCount === 0) return;
                traces.push({
                    type: 'scatter',
                    mode: traceMode(values),
                    name: series.label,
                    x: timestamps,
                    y: values,
                    yaxis: 'y2',
                    line: {color: series.color, dash: series.dash},
                    connectgaps: false,
                    hovertemplate: '%{x|%Y-%m-%d %H:%M:%S}<br>%{y:.1f} W<extra>%{fullData.name}</extra>'
                });
            });
            const hasPower = traces.length > 1;
            const layout = {
                title: page.dataset.title,
                autosize: true,
                height: Math.max(window.innerHeight * 0.7, 420),
                margin: {l: 70, r: hasPower ? 80 : 20, t: 60, b: hasPower ? 140 : 70},
                showlegend: hasPower,
                legend: {orientation: 'h', x: 0, y: -0.25, yanchor: 'top'},
                xaxis: {type: 'date', title: page.dataset.timeLabel + ' (' + page.dataset.timezone + ')'},
                yaxis: {title: page.dataset.socLabel, range: [0, 100], autorange: false, ticksuffix: '%'}
            };
            if (hasPower) {
                layout.yaxis2 = {
                    title: page.dataset.powerLabel, overlaying: 'y', side: 'right',
                    rangemode: 'tozero', ticksuffix: ' W', showgrid: false
                };
            }
            graphCard.hidden = false;
            await Plotly.newPlot(graph, traces, layout, {responsive: true, displaylogo: false});
        } catch (error) {
            showStatus(page.dataset.errorLabel);
        } finally {
            loader.hidden = true;
            retry.disabled = false;
            page.setAttribute('aria-busy', 'false');
            requestPending = false;
        }
    }

    retry.addEventListener('click', loadData);
    window.addEventListener('load', loadData);
})();
