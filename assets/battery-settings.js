(function () {
    const page = document.getElementById('battery-settings-page');
    const button = document.getElementById('settings-load');
    const loader = document.getElementById('loader');
    const status = document.getElementById('settings-status');
    const packsCard = document.getElementById('settings-packs');
    const packsBody = document.getElementById('settings-packs-body');
    let pending = false;

    function lookup(object, path) {
        return path.split('.').reduce(function (value, key) {
            return value === null || value === undefined ? undefined : value[key];
        }, object);
    }

    function format(value, unit) {
        if (value === null || value === undefined) return page.dataset.unavailableLabel;
        return unit ? value + ' ' + unit : String(value);
    }

    function addRow(label, value) {
        const row = document.createElement('tr');
        const head = document.createElement('th');
        head.scope = 'row';
        head.textContent = label;
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(head, cell);
        packsBody.appendChild(row);
    }

    function render(settings) {
        document.querySelectorAll('[data-field]').forEach(function (cell) {
            cell.textContent = format(lookup(settings, cell.dataset.field), cell.dataset.unit);
        });
        document.querySelectorAll('[data-section]').forEach(function (section) { section.hidden = false; });
        packsBody.replaceChildren();
        settings.packs.forEach(function (pack, index) {
            const label = '#' + (index + 1) + ' ' + (pack.serial || '');
            addRow(label, [
                format(pack.socPercent, '%'), pack.state || '', format(pack.powerW, 'W'),
                format(pack.temperatureC, '°C'), format(pack.voltageV, 'V')
            ].join(' · '));
        });
        packsCard.hidden = !settings.packs.length;
        status.textContent = page.dataset.updatedLabel + ': ' + new Date(settings.time * 1000).toLocaleString();
        status.hidden = false;
    }

    function load() {
        if (pending) return;
        pending = true;
        button.disabled = true;
        loader.hidden = false;
        status.hidden = true;
        fetch('/api/battery/settings', {headers: {Accept: 'application/json'}}).then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        }).then(render, function () {
            status.textContent = page.dataset.errorLabel;
            status.hidden = false;
        }).finally(function () {
            pending = false;
            button.disabled = false;
            loader.hidden = true;
        });
    }

    button.addEventListener('click', load);
    load();
})();
