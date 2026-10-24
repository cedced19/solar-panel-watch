// Charts shown under an energy day table: day totals as gauges, tiles, an
// energy flow and two donuts, then the power profile and hourly energy since
// midnight from /api/data/consumption/ (only while the container's
// data-intraday is not "false": the calendar shows past days without them).
// Needs Plotly and /assets/energy-consumption.js; labels come from the
// container's data-*.
(function () {
    const COLORS = {solar: '#2ecc71', grid: '#c0392b', battery: '#8e44ad', house: '#2980b9'};
    const WINDOW = '5m';
    const WINDOW_MS = 5 * 60 * 1000;
    const HOUR_MS = 60 * 60 * 1000;
    const PLOT_CONFIG = {responsive: true, displaylogo: false, displayModeBar: false};
    let requestId = 0;

    const finite = value => Number.isFinite(value) ? value : null;
    const positive = value => Number.isFinite(value) && value > 0 ? value : 0;

    function alpha(hex, opacity) {
        const n = parseInt(hex.slice(1), 16);
        return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + opacity + ')';
    }

    // Split the day totals into source -> use flows. Daily totals cannot say
    // when each kWh moved, so exports and battery charging are taken from
    // solar first: the figures are an estimate of the flows, not a measure.
    // Charging between 22:00 and 06:00 (charging_energy_from_network) cannot
    // be solar, so it comes from the grid; without that figure it is ignored.
    function dayFlows(entry) {
        const row = window.energyConsumption.normalizeEntry(entry);
        if (!Number.isFinite(row.solar_panel) || !Number.isFinite(row.consumption_on_network)) return null;
        const solar = positive(row.solar_panel);
        const gridImport = positive(row.consumption_on_network);
        const gridExport = positive(-row.introduced_on_network);
        const battery = window.energyConsumption.hasBatteryData(row);
        const discharging = battery ? row.battery_discharging : 0;
        const charging = battery ? row.battery_charging : 0;
        const nightCharging = Math.min(positive(row.charging_energy_from_network), charging, gridImport);

        const solarToGrid = Math.min(gridExport, solar);
        const batteryToGrid = Math.min(discharging, gridExport - solarToGrid);
        const solarToBattery = Math.min(charging - nightCharging, solar - solarToGrid);
        const gridToBattery = charging - solarToBattery;
        return {
            battery,
            solar, gridImport, gridExport, discharging, charging,
            house: positive(row.house_consumption),
            solarToHouse: solar - solarToGrid - solarToBattery,
            solarToGrid, solarToBattery,
            batteryToHouse: positive(discharging - batteryToGrid),
            batteryToGrid,
            gridToBattery,
            gridToHouse: positive(gridImport - gridToBattery)
        };
    }

    // Share of the house energy not bought from the grid, and share of the
    // solar energy kept at home (used or stored) instead of exported.
    function dayRatios(entry) {
        const row = window.energyConsumption.normalizeEntry(entry);
        const saved = window.energyConsumption.savedEnergy(row);
        const solar = row.solar_panel;
        return {
            selfSufficiency: Number.isFinite(saved) && row.house_consumption > 0 ?
                Math.min(1, Math.max(0, saved / row.house_consumption)) : null,
            selfConsumption: Number.isFinite(solar) && solar > 0 && Number.isFinite(row.introduced_on_network) ?
                Math.min(1, Math.max(0, (solar + row.introduced_on_network) / solar)) : null
        };
    }

    // Wall-clock parts of a timestamp in the configured zone.
    function zoneClock(timezone) {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
        });
        return function (ms) {
            const parts = {};
            formatter.formatToParts(new Date(ms)).forEach(part => { parts[part.type] = part.value; });
            return {
                day: parts.year + '-' + parts.month + '-' + parts.day,
                hour: parseInt(parts.hour, 10),
                plot: parts.year + '-' + parts.month + '-' + parts.day + 'T' +
                    parts.hour + ':' + parts.minute + ':' + parts.second
            };
        };
    }

    // Each point stands for the power of the time since the previous one,
    // capped at one window so gaps are not bridged. Aggregated points carry
    // their window's end time, so they are placed in the middle of it.
    function samples(points, windowMs) {
        const sorted = (points || []).filter(point => point && Number.isFinite(Date.parse(point._time)))
            .map(point => ({time: Date.parse(point._time), value: finite(point._value)}))
            .sort((first, second) => first.time - second.time);
        return sorted.map((point, index) => {
            const span = index === 0 ? windowMs : Math.min(windowMs, point.time - sorted[index - 1].time);
            return {time: point.time - span / 2, span, value: point.value};
        });
    }

    // Battery power as one signed series: discharging positive, charging negative.
    function batteryNet(balance) {
        const charging = new Map((balance.battery_charging || []).map(point => [point._time, point._value]));
        return (balance.battery_discharging || []).map(point => {
            const charge = charging.get(point._time);
            return {_time: point._time,
                _value: Number.isFinite(point._value) && Number.isFinite(charge) ? point._value - charge : null};
        });
    }

    // kWh per local hour of `day`; hours without readings stay null.
    function hourlyEnergy(balance, day, clock, windowMs) {
        const empty = () => new Array(24).fill(null);
        const result = {solar: empty(), gridImport: empty(), gridExport: empty(),
            discharging: empty(), charging: empty(), house: empty()};
        function add(key, points, transform) {
            samples(points, windowMs).forEach(sample => {
                if (sample.value === null) return;
                const at = clock(sample.time);
                if (at.day !== day) return;
                result[key][at.hour] = (result[key][at.hour] || 0) + transform(sample.value) * sample.span / HOUR_MS / 1000;
            });
        }
        add('solar', balance.power2, value => Math.max(0, value));
        add('gridImport', balance.power1, value => Math.max(0, value));
        add('gridExport', balance.power1, value => Math.min(0, value));
        add('discharging', balance.battery_discharging, value => value);
        add('charging', balance.battery_charging, value => -value);
        add('house', balance.house_consumption, value => value);
        return result;
    }

    // ---- Rendering --------------------------------------------------------

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    const kwh = value => Number.isFinite(value) ? value.toFixed(value >= 10 ? 1 : 2) : null;

    function renderRings(container, ratios, labels) {
        container.innerHTML = '';
        [['selfSufficiency', labels.selfSufficiency, labels.selfSufficiencyHint],
            ['selfConsumption', labels.selfConsumption, labels.selfConsumptionHint]].forEach(([key, title, hint]) => {
            const value = ratios[key];
            const ring = el('div', 'energy-ring' + (value === null ? ' is-unavailable' : ''));
            ring.style.setProperty('--ring-value', value === null ? 0 : value);
            ring.setAttribute('role', 'img');
            ring.setAttribute('aria-label', title + ': ' + (value === null ? labels.unavailable : Math.round(value * 100) + '%'));
            const face = el('div', 'energy-ring-face');
            face.appendChild(el('span', 'energy-ring-value', value === null ? '–' : Math.round(value * 100) + '%'));
            ring.appendChild(face);
            const item = el('div', 'energy-ring-item');
            item.appendChild(ring);
            const text = el('div', 'energy-ring-text');
            text.appendChild(el('strong', '', title));
            text.appendChild(el('span', '', hint));
            item.appendChild(text);
            container.appendChild(item);
        });
    }

    function renderTiles(container, entry, labels) {
        const row = window.energyConsumption.normalizeEntry(entry);
        const share = (value, total) => Number.isFinite(value) && total > 0 ?
            Math.round(value / total * 100) + '% ' + labels.ofHouse : '';
        const tiles = [
            {key: 'solar', label: labels.solarProduced, value: row.solar_panel},
            {key: 'house', label: labels.houseConsumption, value: row.house_consumption},
            {key: 'grid', label: labels.gridImport, value: row.consumption_on_network,
                note: share(row.consumption_on_network, row.house_consumption)},
            {key: 'grid', label: labels.gridExport, outflow: true,
                value: Number.isFinite(row.introduced_on_network) ? Math.abs(row.introduced_on_network) : null},
            {key: 'battery', label: labels.batteryDischarging, value: row.battery_discharging},
            {key: 'battery', label: labels.batteryCharging, value: row.battery_charging, outflow: true,
                note: row.charging_energy_from_network > 0 ?
                    kwh(row.charging_energy_from_network) + ' kWh ' + labels.fromGridAtNight : ''}
        ];
        container.innerHTML = '';
        tiles.forEach(tile => {
            const node = el('div', 'energy-tile');
            node.style.setProperty('--tile-color', COLORS[tile.key]);
            const label = el('span', 'energy-tile-label');
            label.appendChild(el('i', 'energy-swatch' + (tile.outflow ? ' is-outflow' : '')));
            label.appendChild(document.createTextNode(tile.label));
            node.appendChild(label);
            const value = el('span', 'energy-tile-value');
            const text = kwh(tile.value);
            value.appendChild(document.createTextNode(text === null ? labels.unavailable : text));
            if (text !== null) value.appendChild(el('small', '', 'kWh'));
            node.appendChild(value);
            if (tile.note) node.appendChild(el('span', 'energy-tile-note', tile.note));
            container.appendChild(node);
        });
    }

    function renderFlow(target, flows, labels) {
        const nodes = [];
        const index = {};
        function node(key, label, color, value) {
            if (!(key in index)) {
                index[key] = nodes.length;
                nodes.push({label: label + ' · ' + kwh(value) + ' kWh', color});
            }
            return index[key];
        }
        const sources = {
            solar: () => node('solar', labels.solar, COLORS.solar, flows.solar),
            grid: () => node('grid-in', labels.gridImport, COLORS.grid, flows.gridImport),
            battery: () => node('battery-out', labels.batteryDischarging, COLORS.battery, flows.discharging)
        };
        const uses = {
            house: () => node('house', labels.house, COLORS.house, flows.house),
            grid: () => node('grid-out', labels.gridExport, COLORS.grid, flows.gridExport),
            battery: () => node('battery-in', labels.batteryCharging, COLORS.battery, flows.charging)
        };
        const link = {source: [], target: [], value: [], color: []};
        [['solar', 'house', flows.solarToHouse], ['solar', 'battery', flows.solarToBattery],
            ['solar', 'grid', flows.solarToGrid], ['battery', 'house', flows.batteryToHouse],
            ['battery', 'grid', flows.batteryToGrid], ['grid', 'house', flows.gridToHouse],
            ['grid', 'battery', flows.gridToBattery]].forEach(([from, to, value]) => {
            if (!(value > 0.0005)) return;
            link.source.push(sources[from]());
            link.target.push(uses[to]());
            link.value.push(value);
            link.color.push(alpha(COLORS[from], 0.35));
        });
        if (!link.value.length) return false;
        Plotly.newPlot(target, [{
            type: 'sankey', orientation: 'h', valueformat: '.2f', valuesuffix: ' kWh',
            node: {label: nodes.map(item => item.label), color: nodes.map(item => item.color),
                pad: 22, thickness: 16, line: {width: 0},
                hovertemplate: '%{label}<extra></extra>'},
            link: Object.assign(link, {
                hovertemplate: '%{source.label} → %{target.label}<br><b>%{value:.2f} kWh</b><extra></extra>'
            })
        }], {
            margin: {l: 8, r: 8, t: 8, b: 8}, height: 340,
            font: {family: 'Arial, Helvetica, sans-serif', size: 13, color: '#1f2937'}
        }, PLOT_CONFIG);
        return true;
    }

    function renderDonut(target, slices, total, centerLabel) {
        const shown = slices.filter(slice => slice.value > 0.0005);
        if (!shown.length) return false;
        Plotly.newPlot(target, [{
            type: 'pie', hole: 0.64, sort: false, direction: 'clockwise',
            labels: shown.map(slice => slice.label), values: shown.map(slice => slice.value),
            marker: {colors: shown.map(slice => slice.color), line: {color: '#ffffff', width: 2}},
            textinfo: 'percent', textposition: 'outside', textfont: {color: '#1f2937', size: 13},
            hovertemplate: '%{label}<br><b>%{value:.2f} kWh</b> (%{percent})<extra></extra>'
        }], {
            height: 300, margin: {l: 16, r: 16, t: 16, b: 16}, showlegend: true,
            legend: {orientation: 'h', x: 0.5, xanchor: 'center', y: -0.05},
            font: {family: 'Arial, Helvetica, sans-serif', size: 12, color: '#475569'},
            annotations: [{text: '<b>' + kwh(total) + '</b> kWh<br><span style="font-size:11px">' + centerLabel + '</span>',
                showarrow: false, font: {size: 18, color: '#111827'}}]
        }, PLOT_CONFIG);
        return true;
    }

    function dayRange(day) {
        const [year, month, date] = day.split('-').map(part => parseInt(part, 10));
        const next = new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
        return [day + 'T00:00:00', next + 'T00:00:00'];
    }

    function renderProfile(target, balance, day, clock, labels) {
        function trace(points, label, color, extra) {
            const shown = samples(points, WINDOW_MS).filter(sample => clock(sample.time).day === day);
            return Object.assign({
                type: 'scatter', mode: 'lines', name: label,
                x: shown.map(sample => clock(sample.time).plot), y: shown.map(sample => sample.value),
                line: {color, width: 2}, connectgaps: false,
                hovertemplate: '%{y:.0f} W'
            }, extra);
        }
        const traces = [
            trace(balance.power2, labels.solar, COLORS.solar, {fill: 'tozeroy', fillcolor: alpha(COLORS.solar, 0.18)}),
            trace(balance.power1, labels.gridSigned, COLORS.grid),
            trace(batteryNet(balance), labels.batterySigned, COLORS.battery),
            trace(balance.house_consumption, labels.house, COLORS.house, {line: {color: COLORS.house, width: 3}})
        ];
        if (!traces.some(item => item.y.some(Number.isFinite))) return false;
        Plotly.newPlot(target, traces, {
            height: 380, margin: {l: 64, r: 16, t: 8, b: 48}, hovermode: 'x unified',
            font: {family: 'Arial, Helvetica, sans-serif', size: 12, color: '#475569'},
            legend: {orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom'},
            xaxis: {type: 'date', range: dayRange(day), tickformat: '%H:%M', gridcolor: '#f1f5f9',
                title: labels.time + ' (' + labels.timezone + ')'},
            yaxis: {ticksuffix: ' W', gridcolor: '#f1f5f9', zerolinecolor: '#94a3b8', zerolinewidth: 1}
        }, PLOT_CONFIG);
        return true;
    }

    function renderHourly(target, hourly, labels) {
        const hours = hourly.house.map((_, hour) => (hour < 10 ? '0' : '') + hour + ':00');
        const tickStep = document.getElementById(target).offsetWidth < 560 ? 6 : 3;
        // Outflows are lighter and outlined, so they do not rely on the hue.
        function bar(values, label, color, outflow) {
            return {type: 'bar', name: label, x: hours, y: values,
                marker: outflow ? {color: alpha(color, 0.4), line: {color, width: 1.5}} :
                    {color, line: {color: '#ffffff', width: 1}},
                hovertemplate: '%{y:.2f} kWh'};
        }
        const traces = [
            bar(hourly.solar, labels.solar, COLORS.solar),
            bar(hourly.discharging, labels.batteryDischarging, COLORS.battery),
            bar(hourly.gridImport, labels.gridImport, COLORS.grid),
            bar(hourly.gridExport, labels.gridExport, COLORS.grid, true),
            bar(hourly.charging, labels.batteryCharging, COLORS.battery, true),
            {type: 'scatter', mode: 'lines+markers', name: labels.house, x: hours, y: hourly.house,
                line: {color: COLORS.house, width: 2},
                marker: {size: 8, color: COLORS.house, line: {color: '#ffffff', width: 2}},
                hovertemplate: '%{y:.2f} kWh'}
        ];
        if (!hourly.house.concat(hourly.solar, hourly.gridImport).some(Number.isFinite)) return false;
        Plotly.newPlot(target, traces, {
            height: 380, barmode: 'relative', bargap: 0.18, hovermode: 'x unified',
            margin: {l: 64, r: 16, t: 8, b: 40},
            font: {family: 'Arial, Helvetica, sans-serif', size: 12, color: '#475569'},
            legend: {orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom'},
            xaxis: {type: 'category', tickangle: 0, tickvals: hours.filter((_, hour) => hour % tickStep === 0)},
            yaxis: {ticksuffix: ' kWh', gridcolor: '#f1f5f9', zerolinecolor: '#94a3b8', zerolinewidth: 1}
        }, PLOT_CONFIG);
        return true;
    }

    function show(id, visible) {
        document.getElementById(id).hidden = !visible;
    }

    function renderTotals(entry, labels) {
        const hasDay = Boolean(entry && entry.start_date);
        show('energy-glance-card', hasDay);
        if (!hasDay) {
            show('energy-flow-card', false);
            show('energy-donuts', false);
            return;
        }
        renderRings(document.getElementById('energy-rings'), dayRatios(entry), labels);
        renderTiles(document.getElementById('energy-tiles'), entry, labels);

        const flows = dayFlows(entry);
        show('energy-flow-card', Boolean(flows));
        show('energy-donuts', Boolean(flows));
        if (!flows) return;
        if (!renderFlow('energy-flow', flows, labels)) show('energy-flow-card', false);
        show('energy-house-sources-card', true);
        show('energy-solar-uses-card', true);
        const houseSources = [
            {label: labels.solar, value: flows.solarToHouse, color: COLORS.solar},
            {label: labels.battery, value: flows.batteryToHouse, color: COLORS.battery},
            {label: labels.grid, value: flows.gridToHouse, color: COLORS.grid}
        ];
        const solarUses = [
            {label: labels.house, value: flows.solarToHouse, color: COLORS.house},
            {label: labels.battery, value: flows.solarToBattery, color: COLORS.battery},
            {label: labels.grid, value: flows.solarToGrid, color: COLORS.grid}
        ];
        const houseShown = renderDonut('energy-house-sources', houseSources, flows.house, labels.house);
        const solarShown = renderDonut('energy-solar-uses', solarUses, flows.solar, labels.solar);
        show('energy-house-sources-card', houseShown);
        show('energy-solar-uses-card', solarShown);
        show('energy-donuts', houseShown || solarShown);
    }

    // Power since local midnight of the page's day, averaged per window.
    async function renderIntraday(root, labels) {
        const currentRequest = ++requestId;
        const status = document.getElementById('energy-profile-status');
        const minutes = Math.ceil((Date.now() - Date.parse(root.dataset.dayStart)) / 60000);
        const period = Math.min(Math.max(minutes, 1), 1500) + 'm';
        try {
            const response = await fetch('/api/data/consumption/' + period + '?every=' + WINDOW, {cache: 'no-store'});
            if (!response.ok) throw new Error('Power history request failed: ' + response.status);
            const balance = await response.json();
            if (currentRequest !== requestId) return;
            if (!balance || !Array.isArray(balance.power1)) throw new Error('Invalid power balance response.');
            const clock = zoneClock(labels.timezone);
            const day = root.dataset.day;
            show('energy-profile', true);
            show('energy-hourly-card', true);
            const hasProfile = renderProfile('energy-profile', balance, day, clock, labels);
            const hasHourly = renderHourly('energy-hourly', hourlyEnergy(balance, day, clock, WINDOW_MS), labels);
            show('energy-profile', hasProfile);
            show('energy-hourly-card', hasHourly);
            status.textContent = labels.profileEmpty;
            status.hidden = hasProfile;
        } catch (error) {
            if (currentRequest !== requestId) return;
            console.error('Error:', error);
            show('energy-profile', false);
            show('energy-hourly-card', false);
            status.textContent = labels.profileError;
            status.hidden = false;
        }
    }

    function render(entry) {
        const root = document.getElementById('energy-day-visuals');
        const labels = Object.assign({}, root.dataset);
        root.hidden = false;
        renderTotals(entry, labels);
        return root.dataset.intraday === 'false' ? Promise.resolve() : renderIntraday(root, labels);
    }

    window.energyDayVisuals = {render, dayFlows, dayRatios, hourlyEnergy, samples, zoneClock};
})();
