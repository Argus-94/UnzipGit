// UnzipGit — экран «Репозитории»: список, создание, удаление, переход к файлам и распаковке.
(function () {
    'use strict';
    var U = window.UG, $ = U.$, el = U.el;
    var TOKENS_KEY = 'unzipgit_tokens';
    var R = { all: [], filter: 'all', q: '', login: '', loaded: false };
    var FILTERS = [['all', 'Все'], ['mine', 'Мои'], ['private', 'Приватные'], ['public', 'Публичные']];

    var DEL_HINT = 'Для удаления токену нужно право delete_repo (классический токен) или Administration: Read and write (точечный токен), и вы должны быть владельцем репозитория. Токены можно заменить на экране «Токены».';
    var CREATE_HINT = 'Для создания репозитория классическому токену нужно право repo, точечному — Administration: Read and write.';

    function saveTokenLocal(value, login) {
        var list = U.lsJson(TOKENS_KEY, []);
        if (!Array.isArray(list)) list = [];
        if (list.some(function (t) { return t.value === value; })) return;
        list.push({ id: U.randomId(), name: login ? 'Токен ' + login : 'Основной', value: value, kind: 'github', login: login || '', created: Date.now() });
        U.ls(TOKENS_KEY, JSON.stringify(list));
    }
    function activeKey() {
        var raw = U.ls('unzipgit_repo').trim().replace(/^\/+|\/+$/g, '').split('/')[0];
        return (U.ls('unzipgit_username').trim() + '/' + raw).toLowerCase();
    }

    // ---------- подключение ----------
    function showConnect(err) {
        $('main').classList.add('hidden');
        $('fab').classList.add('hidden');
        $('connect').classList.remove('hidden');
        var e = $('cnErr');
        e.textContent = err || '';
        e.classList.toggle('hidden', !err);
    }
    async function connect() {
        var t = $('cnToken').value.trim();
        if (!t) { showConnect('Введите токен доступа'); return; }
        var r = await U.run('Проверка токена…', async function () {
            var x = await U.gh('GET', '/user', undefined, t);
            if (!x.ok) throw new Error(U.errMsg(x));
            return x.data;
        });
        if (!r.ok) return;
        U.ls('unzipgit_token', t);
        U.ls('unzipgit_username', r.v.login);
        saveTokenLocal(t, r.v.login);
        $('cnToken').value = '';
        $('connect').classList.add('hidden');
        load();
    }

    // ---------- загрузка ----------
    async function load() {
        var tk = U.token();
        if (!tk) { showConnect(); return; }
        $('connect').classList.add('hidden');
        $('main').classList.remove('hidden');
        $('fab').classList.remove('hidden');
        var r = await U.run('Загрузка репозиториев…', async function () {
            var me = await U.gh('GET', '/user');
            if (!me.ok) {
                var e = new Error(U.errMsg(me));
                e.auth = me.status === 401;
                throw e;
            }
            var repos = await U.ghAll('/user/repos?sort=updated&affiliation=owner,collaborator,organization_member');
            return { me: me.data, repos: repos };
        });
        if (!r.ok) {
            R.loaded = false;
            $('list').textContent = '';
            var box = el('div', 'empty');
            box.appendChild(U.icon('warn', 40));
            box.appendChild(el('div', '', 'Не удалось загрузить репозитории. Проверьте интернет и токен.'));
            var b = U.btn('primary', 'key', 'Сменить токен', function () { U.goto('tokens.html'); });
            b.style.marginTop = '14px';
            box.appendChild(b);
            $('list').appendChild(box);
            return;
        }
        R.login = r.v.me.login;
        R.all = r.v.repos;
        R.loaded = true;
        U.ls('unzipgit_username', U.ls('unzipgit_username') || R.login);
        $('acct').textContent = 'Аккаунт: ' + R.login + ' · репозиториев: ' + R.all.length;
        render();
    }

    // ---------- отображение ----------
    function renderFilters() {
        var f = $('filters');
        f.textContent = '';
        FILTERS.forEach(function (x) {
            var c = el('button', 'chip' + (R.filter === x[0] ? ' on' : ''), x[1]);
            c.onclick = function () { R.filter = x[0]; render(); };
            f.appendChild(c);
        });
    }
    function visible() {
        var q = R.q.trim().toLowerCase();
        return R.all.filter(function (r) {
            if (R.filter === 'mine' && r.owner.login !== R.login) return false;
            if (R.filter === 'private' && !r.private) return false;
            if (R.filter === 'public' && r.private) return false;
            if (q && (r.full_name + ' ' + (r.description || '')).toLowerCase().indexOf(q) < 0) return false;
            return true;
        });
    }
    function card(r) {
        var act = (r.full_name).toLowerCase() === activeKey();
        var c = el('div', 'card' + (act ? ' active' : ''));
        var top = el('div', 'top');
        var av = el('div', 'avatar');
        av.appendChild(U.icon(r.private ? 'lock' : 'folder', 22));
        top.appendChild(av);
        var m = el('div', 'meta');
        m.appendChild(el('div', 'nm', r.full_name));
        if (r.description) m.appendChild(el('div', 'desc', r.description));
        var info = el('div', 'info');
        var b1 = el('span', 'badge' + (r.private ? '' : ' ok'));
        b1.appendChild(U.icon(r.private ? 'lock' : 'globe', 12));
        b1.appendChild(document.createTextNode(r.private ? 'Приватный' : 'Публичный'));
        info.appendChild(b1);
        if (act) { var b2 = el('span', 'badge on', 'Выбран'); info.appendChild(b2); }
        if (r.archived) info.appendChild(el('span', 'badge', 'Архив'));
        if (r.fork) info.appendChild(el('span', 'badge', 'Форк'));
        if (r.language) info.appendChild(el('span', '', r.language));
        var when = U.ago(r.pushed_at || r.updated_at);
        if (when) info.appendChild(el('span', '', when));
        m.appendChild(info);
        top.appendChild(m);
        var more = U.iconBtn('morevert', 'sm', 'Действия', function () { menu(r); });
        top.appendChild(more);
        c.appendChild(top);
        var a = el('div', 'actions');
        a.appendChild(U.btn('primary', 'folder', 'Файлы', function () { openFiles(r); }));
        a.appendChild(U.btn('', 'archive', 'Распаковать ZIP', function () { openUnzip(r); }));
        a.appendChild(U.btn('', 'tag', 'Релизы', function () { openReleases(r); }));
        c.appendChild(a);
        return c;
    }
    function render() {
        renderFilters();
        var list = $('list');
        list.textContent = '';
        var items = visible();
        if (!items.length) {
            var box = el('div', 'empty');
            box.appendChild(U.icon('folder', 48));
            box.appendChild(el('div', '', R.all.length ? 'Ничего не найдено' : 'У вас пока нет репозиториев'));
            if (!R.all.length) {
                var b = U.btn('primary', 'add', 'Создать репозиторий', createRepo);
                b.style.marginTop = '14px';
                box.appendChild(b);
            }
            list.appendChild(box);
            return;
        }
        var frag = document.createDocumentFragment();
        items.forEach(function (r) { frag.appendChild(card(r)); });
        list.appendChild(frag);
    }

    // ---------- действия ----------
    function select(r) { U.rememberRepo(r.owner.login, r.name, r.default_branch || ''); }
    function openFiles(r) { select(r); U.goto('files.html'); }
    function openUnzip(r) { select(r); U.goto('index.html'); }
    function openReleases(r) { select(r); U.goto('releases.html'); }
    async function menu(r) {
        var items = [
            { id: 'files', icon: 'folder', label: 'Открыть файлы' },
            { id: 'unzip', icon: 'archive', label: 'Распаковать ZIP сюда' },
            { id: 'rel', icon: 'tag', label: 'Релизы' },
            { id: 'gh', icon: 'open', label: 'Открыть на GitHub' },
            { id: 'clone', icon: 'copy', label: 'Копировать адрес (HTTPS)' },
            { id: 'name', icon: 'copy', label: 'Копировать имя' }
        ];
        if (r.permissions && r.permissions.admin) items.push({ id: 'del', icon: 'del', label: 'Удалить репозиторий', danger: true });
        var id = await U.sheet(r.full_name, items);
        if (id === 'files') openFiles(r);
        else if (id === 'unzip') openUnzip(r);
        else if (id === 'rel') openReleases(r);
        else if (id === 'gh') U.openExternal(r.html_url);
        else if (id === 'clone') U.copyText(r.clone_url);
        else if (id === 'name') U.copyText(r.full_name);
        else if (id === 'del') deleteRepo(r);
    }

    async function createRepo() {
        var v = await U.form('Новый репозиторий', null, [
            { id: 'name', label: 'Название', type: 'text', placeholder: 'my-project', hint: 'Латинские буквы, цифры, точка, дефис и подчёркивание' },
            { id: 'desc', label: 'Описание (необязательно)', type: 'text', placeholder: 'Короткое описание' },
            { id: 'priv', label: 'Приватный репозиторий', type: 'checkbox', value: true, hint: 'Видите только вы и те, кого вы пригласите' },
            { id: 'readme', label: 'Создать файл README', type: 'checkbox', value: true, hint: 'Так репозиторий сразу будет готов к работе с файлами' }
        ], 'Создать', function (x) {
            var n = x.name.trim();
            if (!n) return 'Введите название';
            if (!/^[A-Za-z0-9._-]+$/.test(n) || n === '.' || n === '..') return 'Название: только латинские буквы, цифры, «.», «-», «_»';
            return '';
        });
        if (!v) return;
        var name = v.name.trim();
        var r = await U.run('Создание репозитория…', async function () {
            var x = await U.gh('POST', '/user/repos', { name: name, description: v.desc.trim(), private: !!v.priv, auto_init: !!v.readme });
            if (!x.ok) throw new Error(U.errMsg(x, CREATE_HINT));
            return x.data;
        });
        if (!r.ok) return;
        var repo = r.v;
        // GitHub может вернуть неполные права сразу после создания — владелец всегда админ
        repo.permissions = repo.permissions || { admin: true };
        R.all.unshift(repo);
        $('acct').textContent = 'Аккаунт: ' + R.login + ' · репозиториев: ' + R.all.length;
        R.filter = 'all'; R.q = ''; $('q').value = '';
        render();
        var go = await U.modal({
            title: 'Репозиторий создан', text: repo.full_name,
            buttons: [{ label: 'Позже', val: null, kind: 'ghost' }, { label: 'Открыть файлы', val: 'files', kind: 'primary' }]
        });
        if (go && go.val === 'files') openFiles(repo);
    }

    async function deleteRepo(r) {
        var v = await U.form('Удалить репозиторий?',
            'Репозиторий «' + r.full_name + '» будет удалён вместе со всеми файлами, историей, issues и другими данными. Это действие нельзя отменить.\n\nДля подтверждения введите название репозитория:',
            [{ id: 'confirm', label: 'Название', type: 'text', placeholder: r.name }],
            'Удалить навсегда',
            function (x) { return x.confirm.trim() === r.name ? '' : 'Название введено неверно'; }, true);
        if (!v) return;
        var res = await U.run('Удаление…', async function () {
            var x = await U.gh('DELETE', '/repos/' + U.enc(r.owner.login) + '/' + U.enc(r.name));
            if (!x.ok && x.status !== 204) throw new Error(U.errMsg(x, DEL_HINT));
        });
        if (!res.ok) return;
        R.all = R.all.filter(function (x) { return x.id !== r.id; });
        if (activeKey() === r.full_name.toLowerCase()) {
            U.ls('unzipgit_repo', null);
            U.ls('unzipgit_branch', null);
        }
        $('acct').textContent = 'Аккаунт: ' + R.login + ' · репозиториев: ' + R.all.length;
        render();
        U.toast('Репозиторий удалён');
    }

    // ---------- запуск ----------
    document.addEventListener('DOMContentLoaded', function () {
        $('btnRefresh').appendChild(U.icon('refresh', 22));
        $('btnRefresh').onclick = function () { load(); };
        $('searchIco').appendChild(U.icon('search', 20));
        var fab = $('fab');
        fab.appendChild(U.icon('add', 24));
        fab.appendChild(document.createTextNode('Создать'));
        fab.onclick = createRepo;
        $('q').addEventListener('input', function () { R.q = this.value; render(); });
        $('cnOk').onclick = connect;
        $('cnNew').onclick = function () { U.openExternal('https://github.com/settings/tokens/new?description=UnzipGit&scopes=repo,delete_repo'); };
        $('cnToken').addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(); });
        load();
        window.addEventListener('pageshow', function (e) { if (e.persisted && R.loaded) load(); });
    });

    window.__onBack = function () {
        if (U.isModalOpen()) { U.modalCancel(); return true; }
        if (U.isSheetOpen()) { U.closeSheet(); return true; }
        if (U.isBusy()) return true;
        return false;
    };
})();
