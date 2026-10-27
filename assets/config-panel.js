// Configuration panel (/config/): once signed in (see login.js), a form or raw
// JSON editor for config.json or devices-to-activate.json, loaded from and
// saved to /api/config or /api/config/devices.
(function () {
    var SECRET_KEY = /pass|secret|token|tocken/i;

    var login = window.solarLogin;
    var panel = document.getElementById('config-panel');
    var messages = JSON.parse(panel.dataset.messages);

    var editorView = document.getElementById('editor-view');
    var signedInEmail = document.getElementById('signed-in-email');
    var fileTabs = document.querySelectorAll('#file-tabs button');
    var tabForm = document.getElementById('tab-form');
    var tabJson = document.getElementById('tab-json');
    var form = document.getElementById('config-form');
    var jsonArea = document.getElementById('config-json');
    var restartBanner = document.getElementById('restart-banner');
    var restartBtn = document.getElementById('restart-btn');
    var saveBtn = document.getElementById('save-btn');
    var discardBtn = document.getElementById('discard-btn');
    var editorStatus = document.getElementById('editor-status');

    // The files the panel edits: where the server serves them, under which key
    // of its answer, and what their JSON must be at the top level.
    var FILES = {
        config: {name: 'config.json', url: '/api/config', key: 'config', isRoot: isPlainObject, rootError: messages['config-object']},
        devices: {name: 'devices-to-activate.json', url: '/api/config/devices', key: 'devices', isRoot: Array.isArray, rootError: messages['devices-array']}
    };

    var file = FILES.config;   // the file being edited
    var saved = null;          // its content as last loaded from / saved to the server
    var draft = null;          // working copy edited by the form or the JSON tab
    var invalidFields = {};    // form inputs holding an unparsable number
    var jsonError = null;      // parse error of the JSON tab, if any
    var mode = 'form';

    // ---- helpers ---------------------------------------------------------

    function setStatus(element, message, kind) {
        element.textContent = message || '';
        element.className = 'config-status' + (kind ? ' is-' + kind : '');
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

    // The devices file is an array of devices, each shown under its uri.
    function renderForm() {
        invalidFields = {};
        var nodes = Array.isArray(draft)
            ? draft.map(function (item, index) {
                return renderNode(isPlainObject(item) && item.uri ? item.uri : '#' + (index + 1), item, [index]);
            })
            : Object.keys(draft).map(function (key) {
                return renderNode(key, draft[key], [key]);
            });
        form.replaceChildren.apply(form, nodes);
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
            if (!file.isRoot(parsed)) throw new Error(file.rootError);
            draft = parsed;
            jsonError = null;
        } catch (err) {
            jsonError = err.message;
        }
        changed();
    });

    async function loadConfig() {
        var loading = file;
        setStatus(editorStatus, messages.loading);
        try {
            var data = await login.api(loading.url);
            if (loading !== file) return; // another file was opened meanwhile
            setDraft(data[loading.key]);
            restartBanner.hidden = !data.restart_required;
        } catch (err) {
            if (loading === file && err.message !== 'not-authenticated') setStatus(editorStatus, login.failureText(err), 'error');
        }
    }

    // Opens another file, once the changes made to the current one are given up.
    function openFile(name) {
        if (FILES[name] === file) return;
        if ((isDirty() || jsonError !== null) && !window.confirm(messages.unsaved)) return;
        file = FILES[name];
        saved = draft = null;
        jsonError = null;
        fileTabs.forEach(function (tab) { tab.setAttribute('aria-selected', String(tab.dataset.file === name)); });
        jsonArea.setAttribute('aria-label', file.name);
        form.replaceChildren();
        jsonArea.value = '';
        changed();
        loadConfig();
    }

    fileTabs.forEach(function (tab) {
        tab.addEventListener('click', function () { openFile(tab.dataset.file); });
    });

    saveBtn.addEventListener('click', async function () {
        saveBtn.disabled = true;
        setStatus(editorStatus, messages.saving);
        try {
            var data = await login.api(file.url, {method: 'PUT', body: JSON.stringify(draft)});
            setDraft(data[file.key]);
            restartBanner.hidden = !data.restart_required;
            setStatus(editorStatus, messages.saved.replace('{file}', file.name), 'success');
        } catch (err) {
            if (err.message === 'not-authenticated') return;
            setStatus(editorStatus, login.failureText(err), 'error');
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
            await login.api('/api/config/restart', {method: 'POST'});
        } catch (err) {
            restartBtn.disabled = false;
            if (err.message !== 'not-authenticated') setStatus(editorStatus, login.failureText(err), 'error');
            return;
        }
        var deadline = Date.now() + 60000;
        await sleep(2000);
        while (Date.now() < deadline) {
            try {
                var res = await fetch('/api/auth/me', {headers: {Authorization: 'Bearer ' + login.token()}, cache: 'no-store'});
                if (res.status === 401) return login.showLogin(login.messages.sessionExpired);
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

    login.start({
        content: editorView,
        messages: messages,
        onLogin: async function (email) {
            signedInEmail.textContent = email;
            await loadConfig();
        },
        onLogout: function () {
            saved = draft = null;
        },
        confirmLogout: function () {
            return !isDirty() || window.confirm(messages.unsaved);
        }
    });
})();
