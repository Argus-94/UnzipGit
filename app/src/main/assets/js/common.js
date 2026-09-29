// Общие функции для экранов «Репозитории» и «Токены»: хранилище, сеть GitHub, диалоги.
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var enc = encodeURIComponent;

    function ls(k, v) {
        try {
            if (v === undefined) return localStorage.getItem(k) || '';
            if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
        } catch (e) { /* ignore */ }
        return '';
    }
    function lsJson(k, def) {
        try { var v = JSON.parse(ls(k) || 'null'); return v == null ? def : v; } catch (e) { return def; }
    }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    function icon(name, size) { var s = document.createElement('span'); s.innerHTML = window.MI(name, size); return s.firstChild; }
    function iconBtn(name, cls, label, fn) {
        var b = el('button', 'ibtn ' + (cls || ''));
        b.setAttribute('aria-label', label || name);
        b.title = label || '';
        b.appendChild(icon(name, 22));
        if (fn) b.onclick = fn;
        return b;
    }
    function btn(cls, iconName, label, fn) {
        var b = el('button', 'btn ' + (cls || ''));
        if (iconName) b.appendChild(icon(iconName, 18));
        b.appendChild(document.createTextNode(label));
        if (fn) b.onclick = fn;
        return b;
    }

    var toastT = null;
    function toast(msg, ms) {
        var t = $('toast');
        t.textContent = msg;
        t.classList.remove('hidden');
        clearTimeout(toastT);
        toastT = setTimeout(function () { t.classList.add('hidden'); }, ms || 2200);
    }
    function openExternal(url) {
        try {
            if (window.AndroidInterface && typeof window.AndroidInterface.openUrl === 'function') { window.AndroidInterface.openUrl(url); return; }
        } catch (e) { /* ignore */ }
        window.open(url, '_blank');
    }
    function copyText(t) {
        function legacy() {
            var a = document.createElement('textarea');
            a.value = t; a.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
            document.body.appendChild(a); a.select();
            try { document.execCommand('copy'); toast('Скопировано'); } catch (e) { toast('Не удалось скопировать'); }
            a.remove();
        }
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(t).then(function () { toast('Скопировано'); }, legacy);
                return;
            }
        } catch (e) { /* ignore */ }
        legacy();
    }
    function mask(t) {
        t = String(t || '');
        if (t.length <= 10) return '••••••••';
        return t.slice(0, 4) + '••••••••••' + t.slice(-4);
    }
    function ago(iso) {
        if (!iso) return '';
        var d = new Date(iso), s = Math.max(0, (Date.now() - d.getTime()) / 1000);
        if (isNaN(s)) return '';
        if (s < 60) return 'только что';
        if (s < 3600) return Math.floor(s / 60) + ' мин. назад';
        if (s < 86400) return Math.floor(s / 3600) + ' ч. назад';
        if (s < 86400 * 30) return Math.floor(s / 86400) + ' дн. назад';
        return d.toLocaleDateString('ru-RU');
    }
    function fmtDate(ts) {
        var d = new Date(ts);
        return isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }

    // ---------------- диалоги ----------------
    var modalResolve = null, sheetResolve = null, busyDepth = 0;

    // o: {title, text, fields:[{id,label,type,value,placeholder,hint}], buttons:[{label,val,kind}], validate(values)->string|''}
    function modal(o) {
        return new Promise(function (res) {
            var w = $('modalWrap');
            w.textContent = '';
            var c = el('div', 'mcard');
            c.appendChild(el('h3', '', o.title || ''));
            if (o.text) c.appendChild(el('p', '', o.text));
            var inputs = {};
            (o.fields || []).forEach(function (f) {
                var box = el('div', 'fld' + (f.type === 'checkbox' ? ' chk' : ''));
                var inp, lab = el('label', '', f.label || '');
                if (f.type === 'textarea') { inp = el('textarea'); inp.value = f.value || ''; }
                else if (f.type === 'select') {
                    inp = el('select');
                    (f.options || []).forEach(function (op) { var oe = el('option', '', op.label); oe.value = op.value; if (op.value === f.value) oe.selected = true; inp.appendChild(oe); });
                } else {
                    inp = el('input'); inp.type = f.type === 'password' ? 'password' : (f.type === 'checkbox' ? 'checkbox' : 'text');
                    if (f.type === 'checkbox') inp.checked = !!f.value; else inp.value = f.value || '';
                }
                if (f.placeholder) inp.placeholder = f.placeholder;
                inp.setAttribute('autocapitalize', 'off'); inp.setAttribute('autocorrect', 'off'); inp.setAttribute('autocomplete', 'off'); inp.spellcheck = false;
                inp.id = 'mf_' + f.id;
                lab.setAttribute('for', inp.id);
                inputs[f.id] = { el: inp, type: f.type };
                if (f.type === 'checkbox') { box.appendChild(inp); var lw = el('div'); lw.appendChild(lab); if (f.hint) lw.appendChild(el('div', 'hint', f.hint)); box.appendChild(lw); }
                else { box.appendChild(lab); box.appendChild(inp); if (f.hint) box.appendChild(el('div', 'hint', f.hint)); }
                c.appendChild(box);
            });
            var err = el('p', '', ''); err.style.color = 'var(--danger)'; err.classList.add('hidden');
            c.appendChild(err);
            var bar = el('div', 'mbtns');
            function values() {
                var v = {};
                Object.keys(inputs).forEach(function (k) {
                    var i = inputs[k];
                    v[k] = i.type === 'checkbox' ? i.el.checked : i.el.value;
                });
                return v;
            }
            function done(val) {
                w.classList.add('hidden'); w.textContent = ''; modalResolve = null;
                res({ val: val, values: values() });
            }
            (o.buttons || []).forEach(function (b) {
                var bt = el('button', 'mb ' + (b.kind || ''), b.label);
                bt.onclick = function () {
                    if (b.val != null && o.validate) {
                        var m = o.validate(values());
                        if (m) { err.textContent = m; err.classList.remove('hidden'); return; }
                    }
                    done(b.val);
                };
                bar.appendChild(bt);
            });
            c.appendChild(bar);
            w.appendChild(c);
            w.classList.remove('hidden');
            modalResolve = function () { done(null); };
            w.onclick = function (e) { if (e.target === w) done(null); };
            var first = Object.keys(inputs)[0];
            if (first && inputs[first].type !== 'checkbox') setTimeout(function () { try { inputs[first].el.focus(); } catch (e) { /* ignore */ } }, 80);
        });
    }
    function modalCancel() { if (modalResolve) modalResolve(); }
    async function form(title, text, fields, okLabel, validate, danger) {
        var r = await modal({
            title: title, text: text, fields: fields, validate: validate,
            buttons: [{ label: 'Отмена', val: null, kind: 'ghost' }, { label: okLabel || 'OK', val: 'ok', kind: danger ? 'danger' : 'primary' }]
        });
        return r && r.val === 'ok' ? r.values : null;
    }
    async function confirmBox(title, text, okLabel, danger) {
        var r = await modal({ title: title, text: text, buttons: [{ label: 'Отмена', val: null, kind: 'ghost' }, { label: okLabel || 'OK', val: 'ok', kind: danger ? 'danger' : 'primary' }] });
        return !!(r && r.val === 'ok');
    }
    function showError(msg) {
        return modal({ title: 'Ошибка', text: msg, buttons: [{ label: 'OK', val: 'ok', kind: 'primary' }] });
    }
    function sheet(title, items) {
        return new Promise(function (res) {
            var w = $('sheetWrap');
            w.textContent = '';
            var s = el('div', 'sheet');
            if (title) s.appendChild(el('div', 'sh-t', title));
            items.forEach(function (it) {
                var b = el('button', it.danger ? 'danger' : '');
                b.appendChild(icon(it.icon || 'file', 22));
                b.appendChild(document.createTextNode(it.label));
                b.onclick = function () { sheetResolve = null; hideSheet(); res(it.id); };
                s.appendChild(b);
            });
            w.appendChild(s);
            w.classList.remove('hidden');
            sheetResolve = res;
            w.onclick = function (e) { if (e.target === w) closeSheet(); };
        });
    }
    function hideSheet() { var w = $('sheetWrap'); w.classList.add('hidden'); w.textContent = ''; }
    function closeSheet() { var r = sheetResolve; sheetResolve = null; hideSheet(); if (r) r(null); }
    function setBusy(msg) { busyDepth++; $('busyTxt').textContent = msg || 'Подождите…'; $('busy').classList.remove('hidden'); }
    function clearBusy() { busyDepth = Math.max(0, busyDepth - 1); if (!busyDepth) $('busy').classList.add('hidden'); }
    async function run(msg, fn) {
        setBusy(msg);
        try { return { ok: true, v: await fn() }; }
        catch (e) {
            clearBusy(); busyDepth++;
            await showError(String((e && e.message) || e));
            return { ok: false };
        } finally { clearBusy(); }
    }

    // ---------------- сеть GitHub ----------------
    function hasNative() {
        try { return !!(window.AndroidInterface && typeof window.AndroidInterface.httpRequest === 'function'); } catch (e) { return false; }
    }
    function nativeCall(url, method, headers, body) {
        var raw = window.AndroidInterface.httpRequest(JSON.stringify({ url: url, method: method, headers: headers, body: body != null ? body : null, binary: false }));
        var d = JSON.parse(raw);
        if (d.error && !d.status) throw new Error('Сеть: ' + d.error);
        if (!d.status && !d.ok) throw new Error('Нет сети или сервер недоступен');
        var hm = d.headers || {};
        return {
            ok: !!d.ok, status: d.status || 0,
            get: function (n) { var k = Object.keys(hm).find(function (x) { return x.toLowerCase() === String(n).toLowerCase(); }); return k ? hm[k] : null; },
            text: d.body || ''
        };
    }
    async function http(method, url, headers, body, preferNative) {
        if (preferNative && hasNative()) { try { return nativeCall(url, method, headers, body); } catch (e) { /* fallback to fetch */ } }
        try {
            var r = await fetch(url, { method: method, headers: headers, body: body });
            var t = await r.text();
            return { ok: r.ok, status: r.status, get: function (n) { return r.headers.get(n); }, text: t };
        } catch (e) {
            if (hasNative()) return nativeCall(url, method, headers, body);
            throw new Error('Нет сети или запрос заблокирован');
        }
    }
    function token() { return ls('unzipgit_token').trim(); }
    // gh(method, path, body, tokenOverride) -> {ok,status,data,scopes}
    async function gh(method, path, body, tk, preferNative) {
        var url = path.indexOf('http') === 0 ? path : 'https://api.github.com' + path;
        var headers = { 'Authorization': 'token ' + (tk || token()), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        var res = await http(method, url, headers, body !== undefined ? JSON.stringify(body) : undefined, preferNative);
        var data = null;
        if (res.text) { try { data = JSON.parse(res.text); } catch (e) { data = null; } }
        return { ok: res.ok, status: res.status, data: data, scopes: res.get('X-OAuth-Scopes'), res: res };
    }
    function errMsg(r, hint) {
        if (r.status === 401) return 'Неверный токен или срок его действия истёк (401)';
        var m = (r.data && r.data.message) || ('HTTP ' + r.status);
        if (r.data && r.data.errors && r.data.errors.length) {
            m += ' · ' + r.data.errors.map(function (e) { return e.message || e.code || JSON.stringify(e); }).join('; ');
        }
        if ((r.status === 403 || r.status === 404) && hint) m += '\n\n' + hint;
        return m;
    }
    async function ghAll(path, tk) {
        var out = [];
        for (var p = 1; p <= 10; p++) {
            var r = await gh('GET', path + (path.indexOf('?') < 0 ? '?' : '&') + 'per_page=100&page=' + p, undefined, tk);
            if (!r.ok) throw new Error(errMsg(r));
            var arr = Array.isArray(r.data) ? r.data : [];
            out = out.concat(arr);
            if (arr.length < 100) break;
        }
        return out;
    }

    // ---------------- прочее ----------------
    function goto(page) { window.location.href = page; }
    function rememberRepo(owner, repo, branch) {
        ls('unzipgit_username', owner);
        ls('unzipgit_repo', repo);
        ls('unzipgit_branch', branch || '');
        try {
            var key = owner + '/' + repo;
            var h = lsJson('unzipgit_repo_history', []);
            h = [key].concat((Array.isArray(h) ? h : []).filter(function (x) { return x !== key; })).slice(0, 5);
            ls('unzipgit_repo_history', JSON.stringify(h));
        } catch (e) { /* ignore */ }
    }
    function randomId() {
        try { var a = new Uint8Array(6); crypto.getRandomValues(a); return Array.from(a).map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
        catch (e) { return String(Date.now()) + Math.floor(Math.random() * 1e6); }
    }

    window.UG = {
        $: $, enc: enc, ls: ls, lsJson: lsJson, el: el, icon: icon, iconBtn: iconBtn, btn: btn,
        toast: toast, openExternal: openExternal, copyText: copyText, mask: mask, ago: ago, fmtDate: fmtDate,
        modal: modal, form: form, confirmBox: confirmBox, showError: showError, sheet: sheet, closeSheet: closeSheet, modalCancel: modalCancel,
        run: run, setBusy: setBusy, clearBusy: clearBusy,
        gh: gh, ghAll: ghAll, errMsg: errMsg, token: token, goto: goto, rememberRepo: rememberRepo, randomId: randomId,
        isModalOpen: function () { return !$('modalWrap').classList.contains('hidden'); },
        isSheetOpen: function () { return !$('sheetWrap').classList.contains('hidden'); },
        isBusy: function () { return !$('busy').classList.contains('hidden'); }
    };
})();
