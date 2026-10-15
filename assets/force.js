// Force page (/force/): once signed in (see login.js), shows the forcing state
// of each connected device, refreshed every 5 seconds, and forces a device to
// a level (PUT /api/device/:name/force), stops it (level 0) or gives it back to
// the automatic logic (DELETE /api/device/:name/force).
(function () {
    var REFRESH_MS = 5000;

    var login = window.solarLogin;
    var view = document.getElementById('force-view');
    var messages = JSON.parse(view.dataset.messages);
    var percentBox = document.getElementById('percent');
    var cards = {};
    var signedIn = false;
    var timer = null;

    view.querySelectorAll('[data-device]').forEach(function (card) {
        cards[card.dataset.device] = card;
    });

    function showState(uri, state) {
        var card = cards[uri];
        if (!card) return;
        card.querySelector('.force-mode').textContent = state.force_mode ? messages.enabled : messages.disabled;
        card.querySelector('.force-percent').textContent = Math.round(state.force_mode_percent * 100);
        if (state.last_power !== undefined) card.querySelector('.force-power').textContent = Math.floor(state.last_power);
    }

    async function refresh() {
        try {
            var data = await login.api('/api/data-force');
            Object.keys(data.device_states).forEach(function (uri) {
                showState(uri, data.device_states[uri]);
            });
        } catch (err) {
            if (err.message !== 'not-authenticated') console.error(err);
        }
    }

    function stopRefresh() {
        clearInterval(timer);
        timer = null;
    }

    function startRefresh() {
        stopRefresh();
        refresh();
        timer = setInterval(refresh, REFRESH_MS);
    }

    document.addEventListener('visibilitychange', function () {
        if (!signedIn) return;
        if (document.hidden) stopRefresh();
        else startRefresh();
    });

    // percent: level between 0 and 1, or null to give the device back.
    async function force(uri, percent) {
        var result = cards[uri].querySelector('.res');
        var request = percent === null
            ? {method: 'DELETE'}
            : {method: 'PUT', body: JSON.stringify({percent: percent})};
        try {
            var data = await login.api('/api/device/' + encodeURIComponent(uri) + '/force', request);
            showState(uri, {force_mode: data.force_mode, force_mode_percent: data.percent});
            result.textContent = messages.success;
        } catch (err) {
            if (err.message !== 'not-authenticated') result.textContent = login.failureText(err);
        }
    }

    view.addEventListener('click', function (event) {
        var link = event.target.closest('[data-action]');
        if (!link) return;
        event.preventDefault();
        var uri = link.closest('[data-device]').dataset.device;
        var action = link.dataset.action;
        if (action === 'release') return force(uri, null);
        if (action === 'stop') return force(uri, 0);
        var percent = percentBox.value.trim() === '' ? NaN : Number(percentBox.value);
        if (!(percent >= 0 && percent <= 1)) {
            cards[uri].querySelector('.res').textContent = messages['invalid-percent'];
            percentBox.focus();
            return;
        }
        force(uri, percent);
    });

    login.start({
        content: view,
        messages: messages,
        onLogin: function () {
            signedIn = true;
            startRefresh();
        },
        onLogout: function () {
            signedIn = false;
            stopRefresh();
        }
    });
})();
