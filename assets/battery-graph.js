(function () {
    const page = document.getElementById('battery-history-page');
    const loader = document.getElementById('loader');
    const graphCard = document.getElementById('battery-graph-card');
    const graph = document.getElementById('graphs-container');
    const status = document.getElementById('battery-graph-status');
    const message = document.getElementById('battery-graph-message');
    const retry = document.getElementById('battery-graph-retry');
    let requestPending = false;

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
                    Number.isFinite(point._value) && point._value >= 0 && point._value <= 100;
            }).sort(function (first, second) {
                return Date.parse(first._time) - Date.parse(second._time);
            });
            if (points.length === 0) throw new Error('Battery history has no valid readings.');

            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: page.dataset.timezone,
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
            });
            const trace = {
                type: 'scatter',
                mode: points.length === 1 ? 'lines+markers' : 'lines',
                name: page.dataset.socLabel,
                x: points.map(function (point) { return plotTime(Date.parse(point._time), formatter); }),
                y: points.map(function (point) { return point._value; }),
                line: {color: '#2563eb'},
                connectgaps: false,
                hovertemplate: '%{x|%Y-%m-%d %H:%M:%S}<br>%{y:.1f}%<extra></extra>'
            };
            const layout = {
                title: page.dataset.title,
                autosize: true,
                height: Math.max(window.innerHeight * 0.7, 420),
                margin: {l: 70, r: 20, t: 60, b: 70},
                showlegend: false,
                xaxis: {type: 'date', title: page.dataset.timeLabel + ' (' + page.dataset.timezone + ')'},
                yaxis: {title: page.dataset.socLabel, range: [0, 100], autorange: false, ticksuffix: '%'}
            };
            graphCard.hidden = false;
            await Plotly.newPlot(graph, [trace], layout, {responsive: true, displaylogo: false});
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
