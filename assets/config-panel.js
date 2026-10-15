// Configuration panel (/config/): email + one-time code login, then a form or
// raw JSON editor for config.json. The JWT returned by /api/auth/verify is kept
// in localStorage and sent as a Bearer token to /api/config.
(function () {
    var TOKEN_KEY = 'solar-panel-watch.token';
    var SECRET_KEY = /pass|secret|token|tocken/i;

    var panel = document.getElementById('config-panel');
    var messages = JSON.parse(panel.dataset.messages);
    var otpTtl = panel.dataset.otpTtl;
    var loader = document.getElementById('config-loader');
    var logoutBtn = document.getElementById('logout-btn');

    var loginView = document.getElementById('login-view');
    var emailForm = document.getElementById('email-form');
    var emailInput = document.getElementById('login-email');
    var codeForm = document.getElementById('code-form');
    var codeInput = document.getElementById('login-code');
    var codeNote = document.getElementById('code-note');
    var loginStatus = document.getElementById('login-status');

    var editorView = document.getElementById('editor-view');
    var signedInEmail = document.getElementById('signed-in-email');
    var tabForm = document.getElementById('tab-form');
    var tabJson = document.getElementById('tab-json');
    var form = document.getElementById('config-form');
    var jsonArea = document.getElementById('config-json');
    var restartBanner = document.getElementById('restart-banner');
    var restartBtn = document.getElementById('restart-btn');
    var saveBtn = document.getElementById('save-btn');
    var discardBtn = document.getElementById('discard-btn');
    var editorStatus = document.getElementById('editor-status');

    var token = readToken();
    var saved = null;          // config as last loaded from / saved to the server
    var draft = null;          // working copy edited by the form or the JSON tab
    var invalidFields = {};    // form inputs holding an unparsable number
    var jsonError = null;      // parse error of the JSON tab, if any
    var mode = 'form';

    // ---- helpers ---------------------------------------------------------

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
        return data && data.value !== undefined ? message + ' ' + data.value : message;
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function isPlainObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
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

    // ---- views -----------------------------------------------------------

    function showLogin(message) {
        setToken(null);
        loader.hidden = true;
        editorView.hidden = true;
        logoutBtn.hidden = true;
        loginView.hidden = false;
        emailForm.hidden = false;
        codeForm.hidden = true;
        setStatus(loginStatus, message, message ? 'error' : null);
        emailInput.focus();
    }

    async function showEditor(email) {
        loader.hidden = true;
        loginView.hidden = true;
        editorView.hidden = false;
        logoutBtn.hidden = false;
        signedInEmail.textContent = email;
        await loadConfig();
    }

    // ---- login -----------------------------------------------------------

    emailForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        var email = emailInput.value.trim();
        setStatus(loginStatus, messages.sendingCode);
        try {
            await api('/api/auth/request', {method: 'POST', body: JSON.stringify({email: email})});
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
        try {
            var data = await api('/api/auth/verify', {
                method: 'POST',
                body: JSON.stringify({email: emailInput.value.trim(), code: codeInput.value.trim()})
            });
            setToken(data.token);
            setStatus(loginStatus, '');
            await showEditor(data.email);
        } catch (err) {
            setStatus(loginStatus, failureText(err), 'error');
        }
    });

    document.getElementById('change-email').addEventListener('click', function () {
        codeForm.hidden = true;
        emailForm.hidden = false;
        setStatus(loginStatus, '');
        emailInput.focus();
    });

    logoutBtn.addEventListener('click', function () {
        if (isDirty() && !window.confirm(messages.unsaved)) return;
        saved = draft = null;
        showLogin();
    });

    // ---- form rendering ----------------------------------------------------

    function getAt(path) {
        return path.reduce(function (node, key) { return node[key]; }, draft);
    }

    function setAt(path, value) {
        getAt(path.slice(0, -1))[path[path.length - 1]] = value;
        changed();
    }

    function fieldId(path) {
        return 'cfg-' + path.join('-').replace(/[^\w-]/g, '_');
    }

    function element(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    // Shows a config key, letting long snake_case keys wrap after an underscore.
    function keyElement(tag, key) {
        var node = element(tag, 'config-key');
        String(key).split('_').forEach(function (part, index, parts) {
            if (index > 0) node.append(document.createElement('wbr'));
            node.append(part + (index < parts.length - 1 ? '_' : ''));
        });
        return node;
    }

    function smallButton(label, onClick) {
        var button = element('button', 'config-btn config-btn-small', label);
        button.type = 'button';
        button.addEventListener('click', onClick);
        return button;
    }

    // Builds the input for a string, number, boolean or null value at path.
    function renderInput(key, value, path) {
        var input = element('input');
        input.id = fieldId(path);
        if (typeof value === 'boolean') {
            input.type = 'checkbox';
            input.checked = value;
            input.addEventListener('change', function () { setAt(path, input.checked); });
            return input;
        }
        if (typeof value === 'number') {
            input.type = 'number';
            input.step = 'any';
            input.value = String(value);
            input.addEventListener('input', function () {
                var number = input.value.trim() === '' ? NaN : Number(input.value);
                if (Number.isFinite(number)) {
                    delete invalidFields[input.id];
                    input.setCustomValidity('');
                    setAt(path, number);
                } else {
                    invalidFields[input.id] = true;
                    input.setCustomValidity(messages.invalidNumber);
                    changed();
                }
            });
            return input;
        }
        var wasNull = value === null;
        input.type = SECRET_KEY.test(key) ? 'password' : (path[path.length - 2] === 'mails' ? 'email' : 'text');
        input.value = wasNull ? '' : value;
        input.autocomplete = 'off';
        input.spellcheck = false;
        if (wasNull) input.placeholder = 'null';
        input.addEventListener('input', function () {
            setAt(path, wasNull && input.value === '' ? null : input.value);
        });
        return input;
    }

    // Wraps a secret input with a show/hide toggle.
    function withReveal(input) {
        if (input.type !== 'password') return input;
        var wrapper = element('div', 'config-inline');
        var toggle = smallButton(messages.show, function () {
            var hidden = input.type === 'password';
            input.type = hidden ? 'text' : 'password';
            toggle.textContent = hidden ? messages.hide : messages.show;
        });
        wrapper.append(input, toggle);
        return wrapper;
    }

    function renderLeaf(key, value, path) {
        var row = element('div', 'config-field' + (typeof value === 'boolean' ? ' is-checkbox' : ''));
        var label = keyElement('label', key);
        var input = renderInput(key, value, path);
        label.htmlFor = input.id;
        row.append(label, withReveal(input));
        return row;
    }

    function renderObject(key, value, path) {
        var group = element('fieldset', 'config-group');
        group.append(keyElement('legend', key));
        Object.keys(value).forEach(function (child) {
            group.append(renderNode(child, value[child], path.concat(child)));
        });
        return group;
    }

    // Arrays of plain values get add/remove buttons; arrays of objects are
    // edited in place (use the JSON tab to add or remove such entries).
    function renderArray(key, list, path) {
        var group = element('fieldset', 'config-group config-list');
        group.append(keyElement('legend', key));
        var primitive = list.every(function (item) { return item === null || typeof item !== 'object'; });
        function rerender() {
            group.replaceWith(renderArray(key, list, path));
            changed();
        }
        list.forEach(function (item, index) {
            var itemPath = path.concat(index);
            if (!primitive) {
                group.append(renderNode(key + '[' + index + ']', item, itemPath));
                return;
            }
            var row = element('div', 'config-inline');
            var input = renderInput(key, item, itemPath);
            input.setAttribute('aria-label', key + ' ' + (index + 1));
            if (input.type === 'email') input.required = true;
            var remove = smallButton('✕', function () {
                list.splice(index, 1);
                rerender();
            });
            remove.className += ' config-btn-icon';
            remove.title = messages.remove;
            remove.setAttribute('aria-label', messages.remove + ' ' + key + ' ' + (index + 1));
            row.append(input, remove);
            group.append(row);
        });
        if (primitive) {
            group.append(smallButton(messages.add, function () {
                var sample = list[0];
                list.push(typeof sample === 'number' ? 0 : typeof sample === 'boolean' ? false : '');
                rerender();
                var inputs = form.querySelectorAll('#' + fieldId(path.concat(list.length - 1)));
                if (inputs.length) inputs[0].focus();
            }));
        }
        return group;
    }

    function renderNode(key, value, path) {
        if (Array.isArray(value)) return renderArray(key, value, path);
        if (isPlainObject(value)) return renderObject(key, value, path);
        return renderLeaf(key, value, path);
    }

    function renderForm() {
        invalidFields = {};
        form.replaceChildren.apply(form, Object.keys(draft).map(function (key) {
            return renderNode(key, draft[key], [key]);
        }));
    }

    // ---- editing state -----------------------------------------------------

    function isDirty() {
        return saved !== null && JSON.stringify(draft) !== JSON.stringify(saved);
    }

    function changed() {
        var dirty = isDirty();
        var invalid = jsonError !== null || Object.keys(invalidFields).length > 0;
        saveBtn.disabled = !dirty || invalid;
        discardBtn.disabled = !dirty && jsonError === null;
        if (jsonError !== null) setStatus(editorStatus, messages.invalidJson + ' ' + jsonError, 'error');
        else if (invalid) setStatus(editorStatus, messages.invalidNumber, 'error');
        else setStatus(editorStatus, dirty ? messages.unsaved : '');
    }

    function setMode(next) {
        if (next === mode) return;
        if (next === 'form' && jsonError !== null) return; // fix the JSON first
        mode = next;
        tabForm.setAttribute('aria-selected', String(mode === 'form'));
        tabJson.setAttribute('aria-selected', String(mode === 'json'));
        form.hidden = mode !== 'form';
        jsonArea.hidden = mode !== 'json';
        if (mode === 'json') {
            jsonArea.value = JSON.stringify(draft, null, 4);
        } else {
            renderForm();
        }
        changed();
    }

    function setDraft(config) {
        saved = clone(config);
        draft = clone(config);
        jsonError = null;
        if (mode === 'json') jsonArea.value = JSON.stringify(draft, null, 4);
        else renderForm();
        changed();
    }

    tabForm.addEventListener('click', function () { setMode('form'); });
    tabJson.addEventListener('click', function () { setMode('json'); });

    jsonArea.addEventListener('input', function () {
        try {
            var parsed = JSON.parse(jsonArea.value);
            if (!isPlainObject(parsed)) throw new Error(messages['config-object']);
            draft = parsed;
            jsonError = null;
        } catch (err) {
            jsonError = err.message;
        }
        changed();
    });

    async function loadConfig() {
        setStatus(editorStatus, messages.loading);
        try {
            var data = await api('/api/config');
            setDraft(data.config);
            restartBanner.hidden = !data.restart_required;
        } catch (err) {
            if (err.message !== 'not-authenticated') setStatus(editorStatus, failureText(err), 'error');
        }
    }

    saveBtn.addEventListener('click', async function () {
        saveBtn.disabled = true;
        setStatus(editorStatus, messages.saving);
        try {
            var data = await api('/api/config', {method: 'PUT', body: JSON.stringify(draft)});
            setDraft(data.config);
            restartBanner.hidden = !data.restart_required;
            setStatus(editorStatus, messages.saved, 'success');
        } catch (err) {
            if (err.message === 'not-authenticated') return;
            setStatus(editorStatus, failureText(err), 'error');
            saveBtn.disabled = false;
        }
    });

    discardBtn.addEventListener('click', function () {
        setDraft(saved);
    });

    // The server exits after answering; docker/systemd start it again. Wait
    // for it to answer before reloading the configuration.
    restartBtn.addEventListener('click', async function () {
        restartBtn.disabled = true;
        setStatus(editorStatus, messages.restarting);
        try {
            await api('/api/config/restart', {method: 'POST'});
        } catch (err) {
            restartBtn.disabled = false;
            if (err.message !== 'not-authenticated') setStatus(editorStatus, failureText(err), 'error');
            return;
        }
        var deadline = Date.now() + 60000;
        await sleep(2000);
        while (Date.now() < deadline) {
            try {
                var res = await fetch('/api/auth/me', {headers: {Authorization: 'Bearer ' + token}, cache: 'no-store'});
                if (res.status === 401) return showLogin(messages.sessionExpired);
                if (res.ok) {
                    restartBtn.disabled = false;
                    await loadConfig();
                    setStatus(editorStatus, messages.restarted, 'success');
                    return;
                }
            } catch (err) { /* still restarting */ }
            await sleep(1500);
        }
        restartBtn.disabled = false;
        setStatus(editorStatus, messages.restartTimeout, 'error');
    });

    window.addEventListener('beforeunload', function (event) {
        if (isDirty()) {
            event.preventDefault();
            event.returnValue = '';
        }
    });

    // ---- startup: reuse a stored token when it is still valid ---------------

    (async function () {
        if (!token) return showLogin();
        try {
            var data = await api('/api/auth/me');
            await showEditor(data.email);
        } catch (err) {
            showLogin();
        }
    })();
})();
