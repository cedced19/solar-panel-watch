// Email + one-time code login of the pages behind it (/config/, /force/), on
// the card of views/partials/login.ejs. The JWT returned by /api/auth/verify
// is kept in localStorage, so signing in on one page signs in on the other,
// and api() sends it as a Bearer token.
//
// A page calls solarLogin.start(page) once, with:
//   content: element shown while signed in
//   onLogin(email): loads the page once signed in
//   onLogout(): optional, called whenever the login form comes back
//   confirmLogout(): optional, returns false to cancel the log out button
//   messages: optional texts for the error codes of the page's own APIs
window.solarLogin = (function () {
    var TOKEN_KEY = 'solar-panel-watch.token';

    var loginView = document.getElementById('login-view');
    var messages = JSON.parse(loginView.dataset.messages);
    var otpTtl = loginView.dataset.otpTtl;
    var loader = document.getElementById('login-loader');
    var logoutBtn = document.getElementById('logout-btn');
    var emailForm = document.getElementById('email-form');
    var emailInput = document.getElementById('login-email');
    var senderSetup = document.getElementById('sender-setup');
    var senderUser = document.getElementById('sender-user');
    var senderPass = document.getElementById('sender-pass');
    var codeForm = document.getElementById('code-form');
    var codeInput = document.getElementById('login-code');
    var codeNote = document.getElementById('code-note');
    var loginStatus = document.getElementById('login-status');

    var token = readToken();
    var page = null;

    function readToken() {
        try { return localStorage.getItem(TOKEN_KEY); } catch (err) { return null; }
    }

    function setToken(value) {
        token = value;
        try {
            if (value) localStorage.setItem(TOKEN_KEY, value);
            else localStorage.removeItem(TOKEN_KEY);
        } catch (err) { /* private mode: keep the token in memory only */ }
    }

    function setStatus(element, message, kind) {
        element.textContent = message || '';
        element.className = 'config-status' + (kind ? ' is-' + kind : '');
    }

    function errorMessage(data) {
        var code = data && data.error;
        var message = (code && messages[code]) || messages.requestFailed;
        if (data && data.value !== undefined) message += ' ' + data.value;
        if (data && data.detail) message += ' ' + data.detail;
        return message;
    }

    // Calls a JSON endpoint with the stored token. A 401 sends back to login.
    async function api(url, options) {
        options = options || {};
        options.headers = Object.assign({'Content-Type': 'application/json'}, options.headers);
        if (token) options.headers.Authorization = 'Bearer ' + token;
        options.cache = 'no-store';
        var res = await fetch(url, options);
        var data = await res.json().catch(function () { return {}; });
        if (res.status === 401 && url.indexOf('/api/auth/') !== 0) {
            showLogin(messages.sessionExpired);
            throw new Error('not-authenticated');
        }
        if (!res.ok) {
            var error = new Error(errorMessage(data));
            error.handled = true;
            throw error;
        }
        return data;
    }

    function failureText(err) {
        return err && err.handled ? err.message : messages.requestFailed;
    }

    // Asks for a sender on the login form while none is configured.
    function setSenderSetup(needed) {
        senderSetup.hidden = !needed;
        senderSetup.disabled = !needed;
    }

    function showLogin(message) {
        setToken(null);
        loader.hidden = true;
        page.content.hidden = true;
        logoutBtn.hidden = true;
        loginView.hidden = false;
        emailForm.hidden = false;
        codeForm.hidden = true;
        setStatus(loginStatus, message, message ? 'error' : null);
        emailInput.focus();
        if (page.onLogout) page.onLogout();
        fetch('/api/auth/status', {cache: 'no-store'})
            .then(function (res) { return res.json(); })
            .then(function (data) { setSenderSetup(!data.sender_configured); })
            .catch(function () { /* keep the state rendered by the server */ });
    }

    async function showContent(email) {
        loader.hidden = true;
        loginView.hidden = true;
        page.content.hidden = false;
        logoutBtn.hidden = false;
        await page.onLogin(email);
    }

    emailForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        var email = emailInput.value.trim();
        var body = {email: email};
        if (!senderSetup.disabled) body.sender = {user: senderUser.value.trim(), pass: senderPass.value};
        setStatus(loginStatus, messages.sendingCode);
        try {
            await api('/api/auth/request', {method: 'POST', body: JSON.stringify(body)});
            codeNote.textContent = messages.codeSent.replace('{email}', email).replace('{minutes}', otpTtl);
            emailForm.hidden = true;
            codeForm.hidden = false;
            codeInput.value = '';
            codeInput.focus();
            setStatus(loginStatus, '');
        } catch (err) {
            setStatus(loginStatus, failureText(err), 'error');
        }
    });

    codeForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        setStatus(loginStatus, messages.checking);
        var data;
        try {
            data = await api('/api/auth/verify', {
                method: 'POST',
                body: JSON.stringify({email: emailInput.value.trim(), code: codeInput.value.trim()})
            });
        } catch (err) {
            setStatus(loginStatus, failureText(err), 'error');
            return;
        }
        setToken(data.token);
        setStatus(loginStatus, '');
        senderPass.value = '';
        setSenderSetup(false);
        await showContent(data.email);
    });

    document.getElementById('change-email').addEventListener('click', function () {
        codeForm.hidden = true;
        emailForm.hidden = false;
        setStatus(loginStatus, '');
        emailInput.focus();
    });

    logoutBtn.addEventListener('click', function () {
        if (page.confirmLogout && !page.confirmLogout()) return;
        showLogin();
    });

    // Reuses a stored token when it is still valid.
    async function start(options) {
        page = options;
        Object.assign(messages, page.messages);
        if (!token) return showLogin();
        var data;
        try {
            data = await api('/api/auth/me');
        } catch (err) {
            return showLogin();
        }
        await showContent(data.email);
    }

    return {
        start: start,
        api: api,
        failureText: failureText,
        showLogin: showLogin,
        token: function () { return token; },
        messages: messages
    };
})();
