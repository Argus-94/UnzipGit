(function () {
    'use strict';
    var U = window.UG, $ = U.$, el = U.el;
    var N = window.AndroidInterface;
    var repoRaw = U.ls('unzipgit_repo').trim().replace(/^\/+|\/+$/g, '');
    var owner = U.ls('unzipgit_username').trim();
    var repo = repoRaw.split('/').pop();
    if (repoRaw.indexOf('/') >= 0) owner = repoRaw.split('/')[0];
    var branch = U.ls('unzipgit_branch').trim() || 'main';
    var workflows = [], runs = [];
    var runFilter = 'all';
    var actionsEnabled = null; // true | false | null (unknown)
    var actionsPermMsg = '';
    var dlCb = {}; // id -> { done, progress }
    var autoRefreshTimer = null;
    var prevRunStatus = {}; // id -> status|conclusion
    function notifyRunFinished(run) {
        var title = (run.name || 'Workflow') + ' #' + run.run_number;
        var ok = run.conclusion === 'success';
        var msg = title + ' — ' + (ok ? 'успех' : (run.conclusion || 'завершён'));
        try {
            if (window.AndroidInterface && typeof window.AndroidInterface.showToast === 'function') {
                window.AndroidInterface.showToast(msg);
            }
        } catch (e) {}
        U.toast(msg, 4000);
    }
    function detectFinishedRuns(newRuns) {
        (newRuns || []).forEach(function (r) {
            var id = String(r.id);
            var key = (r.status || '') + '|' + (r.conclusion || '');
            var prev = prevRunStatus[id];
            if (prev && prev.indexOf('completed') < 0 && r.status === 'completed') {
                notifyRunFinished(r);
            }
            prevRunStatus[id] = key;
        });
    }
    var lastPermIssue = null; // { kind, message }
    var lastRunHint = null;   // { path, text } подсказка при правке YAML после ошибки

    // ---------- права токена: понятный запрос ----------
    var PERM_HELP = {
        actions_read: {
            title: 'Нужен доступ Actions (чтение)',
            body: 'Токену не хватает права читать GitHub Actions.\n\n' +
                'Fine-grained PAT:\n• Repository access — этот репозиторий\n• Permissions → Actions: Read\n\n' +
                'Classic PAT:\n• scope repo (для private) или public_repo\n• workflow — если правите YAML запусков\n\n' +
                'После изменения токена обновите его на экране «Токены».'
        },
        actions_write: {
            title: 'Нужен доступ Actions (запись)',
            body: 'Для запуска, отмены, повторa и управления workflow нужно:\n\n' +
                'Fine-grained PAT:\n• Actions: Read and write\n\n' +
                'Classic PAT:\n• repo + workflow\n\n' +
                'Без этого GitHub вернёт 403.'
        },
        contents: {
            title: 'Нужен доступ Contents',
            body: 'Для чтения и правки YAML workflow нужно:\n\n' +
                'Fine-grained PAT:\n• Contents: Read and write\n\n' +
                'Classic PAT:\n• scope repo\n\n' +
                'Если ветка защищена — нужны права на push или обход branch protection.'
        },
        admin: {
            title: 'Нужны права администратора',
            body: 'Включение Actions на уровне репозитория требует:\n\n' +
                'Fine-grained PAT:\n• Administration: Read and write\n\n' +
                'Classic PAT:\n• scope repo и права владельца/admin репозитория\n\n' +
                'Либо включите Actions вручную: GitHub → Settings → Actions → General.'
        },
        generic: {
            title: 'Недостаточно прав',
            body: 'GitHub отклонил запрос (часто 401/403).\nПроверьте токен на экране «Токены» и права для этого репозитория.'
        }
    };

    function classifyPermError(status, message) {
        var m = String(message || '').toLowerCase();
        if (status === 401) return 'generic';
        if (m.indexOf('administration') >= 0 || m.indexOf('admin') >= 0 && m.indexOf('actions') >= 0) return 'admin';
        if (m.indexOf('content') >= 0 || m.indexOf('contents') >= 0) return 'contents';
        if (m.indexOf('workflow') >= 0 && (m.indexOf('write') >= 0 || m.indexOf('dispatch') >= 0)) return 'actions_write';
        if (m.indexOf('actions') >= 0 || m.indexOf('resource not accessible') >= 0) {
            if (m.indexOf('write') >= 0 || m.indexOf('create') >= 0 || m.indexOf('cancel') >= 0) return 'actions_write';
            return 'actions_read';
        }
        if (status === 403) return 'actions_write';
        return null;
    }

    async function askPerms(kind, extra) {
        var h = PERM_HELP[kind] || PERM_HELP.generic;
        lastPermIssue = { kind: kind, message: extra || '' };
        var text = h.body + (extra ? '\n\n—\n' + extra : '');
        var ans = await U.modal({
            title: h.title,
            text: text,
            buttons: [
                { label: 'Позже', val: 'close' },
                { label: 'Токены в приложении', val: 'tokens' },
                { label: 'Настройки токена GitHub', val: 'gh', kind: 'primary' }
            ]
        });
        if (!ans) return;
        if (ans.val === 'tokens') U.goto('tokens.html');
        else if (ans.val === 'gh') {
            U.openExternal('https://github.com/settings/tokens?type=beta');
        }
    }

    async function handleApiFail(x, defaultHint, preferKind) {
        var msg = U.errMsg(x, defaultHint || '');
        var kind = preferKind || classifyPermError(x && x.status, msg);
        if (kind && (x.status === 401 || x.status === 403 || /resource not accessible|permission|scope|not allowed/i.test(msg))) {
            await askPerms(kind, msg);
            return msg;
        }
        throw new Error(msg);
    }

    // ---------- подсказки по YAML / ошибкам запуска ----------
    function yamlHints(content, ctx) {
        ctx = ctx || {};
        var hints = [];
        var t = String(content || '');
        if (!t.trim()) {
            hints.push('Файл пустой — добавьте name, on и jobs.');
            return hints;
        }
        if (!/^\s*on\s*:/m.test(t) && !/\non\s*:/.test(t)) {
            hints.push('Нет блока on: — GitHub не знает, когда запускать workflow.');
        }
        if (ctx.needDispatch || ctx.dispatchFailed) {
            if (!/workflow_dispatch/.test(t)) {
                hints.push('Для ручного запуска из приложения нужен trigger:\n  on:\n    workflow_dispatch:');
            }
        }
        if (!/^\s*jobs\s*:/m.test(t) && !/\njobs\s*:/.test(t)) {
            hints.push('Нет блока jobs: — нечего выполнять.');
        }
        if (/jobs\s*:/.test(t) && !/runs-on\s*:/.test(t)) {
            hints.push('У job обычно нужен runs-on: (например ubuntu-latest).');
        }
        // tabs often break YAML
        if (/\t/.test(t)) {
            hints.push('В файле есть символы TAB — в YAML лучше только пробелы. Смешение отступов часто ломает workflow.');
        }
        if (ctx.failedSummary) {
            hints.push('Ошибка последнего запуска:\n' + ctx.failedSummary);
        }
        if (ctx.apiError) {
            hints.push('Ответ GitHub:\n' + ctx.apiError);
        }
        // common android template issues
        if (/assembleDebug/.test(t) && !/gradlew/.test(t)) {
            hints.push('Есть assembleDebug, но нет вызова ./gradlew — проверьте steps.');
        }
        return hints;
    }

    function formatHints(hints) {
        if (!hints || !hints.length) return '';
        return '\n\n── Подсказки ──\n' + hints.map(function (h, i) { return (i + 1) + ') ' + h; }).join('\n\n');
    }

    async function failedRunSummary(rn) {
        try {
            var x = await api('GET', '/actions/runs/' + encodeURIComponent(rn.id) + '/jobs?per_page=50');
            if (!x.ok) return (rn.conclusion || rn.status || 'ошибка') + ' (jobs недоступны)';
            var jobs = (x.data && x.data.jobs) || [];
            var parts = [];
            jobs.forEach(function (j) {
                if (j.conclusion === 'success' || j.conclusion === 'skipped') return;
                var line = (j.name || 'job') + ': ' + (j.conclusion || j.status || '?');
                if (j.steps && j.steps.length) {
                    var bad = j.steps.filter(function (s) {
                        return s.conclusion === 'failure' || s.conclusion === 'timed_out';
                    });
                    if (bad.length) {
                        line += '\n   шаг: ' + bad.map(function (s) { return s.name; }).join(', ');
                    }
                }
                parts.push(line);
            });
            if (!parts.length) return 'Заключение: ' + (rn.conclusion || rn.status || 'неизвестно');
            return parts.join('\n');
        } catch (e) {
            return String((e && e.message) || e);
        }
    }


    // ---------- helpers ----------
    function endpoint(path) {
        return '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + path;
    }
    function api(method, path, body) { return U.gh(method, endpoint(path), body); }
    function statusClass(run) {
        if (run.status && run.status !== 'completed') return run.status;
        return run.conclusion || run.status || 'unknown';
    }
    function statusLabel(run) {
        if (run.status && run.status !== 'completed') {
            var map = { in_progress: 'Идёт', queued: 'В очереди', waiting: 'Ожидание', pending: 'Ожидание', requested: 'Запрошен' };
            return map[run.status] || run.status;
        }
        var c = {
            success: 'Успех', failure: 'Ошибка', cancelled: 'Отменён',
            timed_out: 'Таймаут', action_required: 'Нужно действие', skipped: 'Пропущен', neutral: 'Нейтрально'
        };
        return c[run.conclusion] || run.conclusion || '—';
    }
    function showError(message) {
        var box = $('errorBox');
        box.textContent = message || '';
        box.classList.toggle('hidden', !message);
    }
    function date(value) {
        if (!value) return '';
        try { return new Date(value).toLocaleString('ru-RU'); } catch (_) { return value; }
    }
    function btn(label, kind, action) {
        var b = el('button', 'small-btn' + (kind ? ' ' + kind : ''), label);
        b.onclick = action;
        return b;
    }
    function duration(run) {
        if (!run.created_at) return '';
        var start = new Date(run.run_started_at || run.created_at).getTime();
        var end = run.updated_at ? new Date(run.updated_at).getTime() : Date.now();
        if (!start || end < start) return '';
        var sec = Math.round((end - start) / 1000);
        if (sec < 60) return sec + ' с';
        if (sec < 3600) return Math.floor(sec / 60) + ' мин';
        return Math.floor(sec / 3600) + ' ч ' + Math.floor((sec % 3600) / 60) + ' мин';
    }
    function fmtSize(n) {
        if (!n && n !== 0) return '';
        if (n > 1048576) return (n / 1048576).toFixed(1) + ' МБ';
        if (n > 1024) return Math.round(n / 1024) + ' КБ';
        return n + ' Б';
    }
    function wfStateLabel(state) {
        if (state === 'active') return 'включён';
        if (state === 'disabled_manually') return 'выключен вручную';
        if (state === 'disabled_inactivity') return 'выключен (неактивность)';
        if (state === 'disabled') return 'выключен';
        return state || '—';
    }
    function isWfActive(w) { return w.state === 'active'; }

    // ---------- статус Actions на репозитории ----------
    function renderActionsStatus() {
        var box = $('actionsStatus');
        if (!box) return;
        box.classList.remove('hidden', 'on', 'off', 'unknown');
        // убрать старую кнопку включения, если была
        var oldBtn = box.querySelector('.as-enable');
        if (oldBtn) oldBtn.remove();
        if (actionsEnabled === true) {
            box.classList.add('on');
            $('asTitle').textContent = 'Actions включены';
            $('asSub').textContent = actionsPermMsg || 'Workflows и запуски доступны. Токену нужны Actions: Read and write.';
        } else if (actionsEnabled === false) {
            box.classList.add('off');
            $('asTitle').textContent = 'Actions выключены';
            $('asSub').textContent = actionsPermMsg ||
                'В этом репозитории GitHub Actions отключены. Можно включить здесь (нужен admin) или в настройках репозитория на GitHub.';
            var b = el('button', 'small-btn primary as-enable', 'Включить Actions');
            b.style.marginTop = '8px';
            b.onclick = function () { enableRepoActions(); };
            box.querySelector('.as-body').appendChild(b);
        } else {
            box.classList.add('unknown');
            $('asTitle').textContent = 'Статус Actions неизвестен';
            $('asSub').textContent = actionsPermMsg || 'Не удалось проверить права. Список workflow ниже покажет, есть ли доступ.';
        }
    }

    // ---------- карточки ----------
    function workflowCard(w) {
        var c = el('div', 'wf-card');
        var title = el('div', 'wf-title', w.name || w.path || ('Workflow #' + w.id));
        var badge = el('span', 'state-badge ' + (isWfActive(w) ? 'on' : 'off'), isWfActive(w) ? 'Вкл' : 'Выкл');
        title.appendChild(badge);
        c.appendChild(title);
        c.appendChild(el('div', 'wf-path', (w.path || (w._fromRuns ? 'из истории запусков' : '—')) + (w._fromRuns ? '' : (' · ' + wfStateLabel(w.state)))));

        var a = el('div', 'wf-actions');
        // Главное действие — запуск (если активен и Actions вкл)
        if (isWfActive(w) && actionsEnabled !== false) {
            a.appendChild(btn('▶ Запустить', 'primary', function () { dispatch(w); }));
        } else if (!isWfActive(w)) {
            a.appendChild(btn('Включить', 'primary', function () { setWorkflowState(w, true); }));
        }
        a.appendChild(btn('Запуски', '', function () { loadRunsForWorkflow(w); }));
        a.appendChild(btn('⋯', 'ghost', function () { workflowMenu(w); }));
        c.appendChild(a);
        return c;
    }

    async function workflowMenu(w) {
        var items = [
            { id: 'edit', icon: 'edit', label: 'Редактировать YAML' },
            { id: 'runs', icon: 'refresh', label: 'Только запуски этого workflow' }
        ];
        if (isWfActive(w)) {
            items.push({ id: 'disable', icon: 'close', label: 'Выключить workflow', danger: true });
        } else {
            items.push({ id: 'enable', icon: 'check', label: 'Включить workflow' });
        }
        if (w.html_url) items.push({ id: 'gh', icon: 'open', label: 'Открыть на GitHub' });
        items.push({ id: 'del', icon: 'del', label: 'Удалить YAML-файл', danger: true });

        var id = await U.sheet(w.name || w.path || 'Workflow', items);
        if (id === 'edit') {
            if (!w.path) { U.toast('Путь YAML неизвестен — откройте файл в «Файлы»'); }
            else editWorkflow(w.path, w.name || w.path);
        }
        else if (id === 'runs') loadRunsForWorkflow(w);
        else if (id === 'enable') setWorkflowState(w, true);
        else if (id === 'disable') setWorkflowState(w, false);
        else if (id === 'gh' && w.html_url) U.openExternal(w.html_url);
        else if (id === 'del') {
            if (!w.path) U.toast('Нет пути к YAML');
            else deleteWorkflow(w.path, w.name || w.path);
        }
    }

    function runCard(r) {
        var c = el('div', 'run-card');
        c.appendChild(el('div', 'run-title', (r.name || r.display_title || 'Запуск') + ' · #' + r.run_number));
        c.appendChild(el('span', 'status ' + statusClass(r), statusLabel(r)));
        var meta = (r.head_branch || '—') + ' · ' + ((r.actor && r.actor.login) || '—');
        var dur = duration(r);
        if (dur) meta += ' · ' + dur;
        c.appendChild(el('div', 'run-meta', meta));
        c.appendChild(el('div', 'run-meta', date(r.updated_at || r.created_at)));

        var a = el('div', 'run-actions');
        if (r.status === 'completed') {
            a.appendChild(btn('↻ Повторить', 'primary', function () { rerun(r); }));
        } else if (r.status === 'in_progress' || r.status === 'queued' || r.status === 'waiting' || r.status === 'pending' || r.status === 'requested') {
            a.appendChild(btn('■ Стоп', 'danger', function () { cancel(r); }));
        }
        a.appendChild(btn('Артефакты', '', function () { openArtifacts(r); }));
        a.appendChild(btn('⋯', 'ghost', function () { runMenu(r); }));
        c.appendChild(a);
        return c;
    }

    async function runMenu(r) {
        var items = [
            { id: 'jobs', icon: 'code', label: 'Задания и логи' },
            { id: 'arts', icon: 'download', label: 'Артефакты / скачать' }
        ];
        if (r.status === 'completed') {
            items.push({ id: 'rerun', icon: 'refresh', label: 'Повторить весь запуск' });
            if (r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled') {
                items.push({ id: 'rerun_failed', icon: 'refresh', label: 'Повторить только failed jobs' });
                items.push({ id: 'fixyaml', icon: 'edit', label: 'Исправить YAML (подсказки по ошибке)' });
            }
            items.push({ id: 'del', icon: 'del', label: 'Удалить из истории', danger: true });
        } else if (r.status === 'in_progress' || r.status === 'queued' || r.status === 'waiting' || r.status === 'pending') {
            items.push({ id: 'cancel', icon: 'close', label: 'Отменить запуск', danger: true });
        }
        if (r.html_url) items.push({ id: 'gh', icon: 'open', label: 'Открыть на GitHub' });

        var id = await U.sheet('Run #' + r.run_number, items);
        if (id === 'jobs') openJobs(r);
        else if (id === 'arts') openArtifacts(r);
        else if (id === 'rerun') rerun(r);
        else if (id === 'rerun_failed') rerunFailed(r);
        else if (id === 'fixyaml') fixWorkflowFromRun(r);
        else if (id === 'cancel') cancel(r);
        else if (id === 'del') deleteRun(r);
        else if (id === 'gh' && r.html_url) U.openExternal(r.html_url);
    }

    async function fixWorkflowFromRun(rn) {
        var summary = await failedRunSummary(rn);
        // path workflow из run
        var path = rn.path || '';
        if (!path && rn.workflow_id) {
            for (var i = 0; i < workflows.length; i++) {
                if (String(workflows[i].id) === String(rn.workflow_id)) {
                    path = workflows[i].path || '';
                    break;
                }
            }
        }
        if (!path) {
            await U.modal({
                title: 'Ошибка запуска #' + rn.run_number,
                text: summary + '\n\nПуть YAML неизвестен — откройте workflow вручную из списка выше.',
                buttons: [{ label: 'OK', val: 'ok', kind: 'primary' }]
            });
            return;
        }
        lastRunHint = { path: path, text: summary };
        var name = path.split('/').pop();
        await editWorkflow(path, name, { failedSummary: summary, needDispatch: false });
    }

    function render() {
        var wf = $('workflows'), rr = $('runs');
        wf.textContent = ''; rr.textContent = '';

        if (!workflows.length) {
            wf.appendChild(el('div', 'empty',
                actionsEnabled === false
                    ? 'Actions выключены — workflow недоступны.'
                    : 'Workflow не найдены. Создайте YAML в .github/workflows/ или нажмите «＋ Workflow».'
            ));
        } else {
            workflows.forEach(function (w) { wf.appendChild(workflowCard(w)); });
        }

        var filtered = runs;
        if (runFilter === 'success') filtered = runs.filter(function (r) { return r.conclusion === 'success'; });
        else if (runFilter === 'failure') filtered = runs.filter(function (r) {
            return r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled';
        });
        else if (runFilter === 'in_progress') filtered = runs.filter(function (r) {
            return r.status && r.status !== 'completed';
        });

        var filtersBar = el('div', 'filter-bar');
        [['all', 'Все'], ['success', 'Успех'], ['failure', 'Ошибки'], ['in_progress', 'Активные']].forEach(function (pair) {
            var b = el('button', 'small-btn' + (runFilter === pair[0] ? ' primary' : ''), pair[1]);
            b.onclick = function () { runFilter = pair[0]; render(); };
            filtersBar.appendChild(b);
        });
        rr.appendChild(filtersBar);

        if (!filtered.length) {
            rr.appendChild(el('div', 'empty', runs.length ? 'Нет запусков с этим фильтром.' : 'Запусков пока нет.'));
        } else {
            filtered.forEach(function (r) { rr.appendChild(runCard(r)); });
        }
    }

    // ---------- contents API ----------
    function b64decode(value) {
        try { return decodeURIComponent(escape(atob((value || '').replace(/\s/g, '')))); }
        catch (_) { try { return atob((value || '').replace(/\s/g, '')); } catch (e) { return ''; } }
    }
    function b64encode(value) {
        try { return btoa(unescape(encodeURIComponent(value))); }
        catch (_) { return btoa(value); }
    }
    async function getFile(path) {
        var x = await api('GET', '/contents/' + path.split('/').map(encodeURIComponent).join('/'));
        if (!x.ok) {
            if (x.status === 404) return { exists: false, text: '' };
            // 401/403: один диалог прав через handleApiFail только если не вложены в U.run-цепочку save
            if (x.status === 401 || x.status === 403) {
                var msg = U.errMsg(x, 'Не удалось прочитать файл. Contents: Read.');
                await askPerms('contents', msg);
                throw new Error(msg);
            }
            throw new Error(U.errMsg(x, 'Не удалось прочитать файл. Contents: Read.'));
        }
        return { exists: true, sha: x.data.sha, text: b64decode(x.data.content) };
    }
    // ---------- YAML editor с подсветкой и пометкой ошибок ----------
    function findErrorLines(content, hintCtx) {
        var lines = String(content || '').split('\n');
        var marks = {}; // line index -> reason
        function mark(i, reason) {
            if (i < 0 || i >= lines.length) return;
            if (!marks[i]) marks[i] = reason;
        }
        lines.forEach(function (line, i) {
            if (/\t/.test(line)) mark(i, 'TAB — в YAML нужны только пробелы');
        });
        if (!/^\s*on\s*:/m.test(content) && !/\non\s*:/.test(content)) {
            mark(0, 'нет блока on:');
        }
        if (hintCtx && hintCtx.failedSummary) {
            var sum = String(hintCtx.failedSummary);
            // "шаг: Name1, Name2"
            var m = sum.match(/шаг:\s*([^\n]+)/i);
            if (m) {
                m[1].split(',').forEach(function (raw) {
                    var name = raw.trim();
                    if (!name) return;
                    var needle = name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
                    lines.forEach(function (line, i) {
                        if (line.indexOf(name) >= 0 || (needle && line.indexOf(needle) >= 0)) {
                            mark(i, 'упавший шаг: ' + name);
                        }
                        // name: "step name" patterns
                        if (/^\s*-\s*name:\s*/.test(line) && line.indexOf(needle.split(' ')[0]) >= 0) {
                            mark(i, 'возможный упавший шаг');
                        }
                    });
                });
            }
            // job name: bootstrap: failure
            var jm = sum.match(/^([^\n:]+):\s*(failure|timed_out|cancelled)/im);
            if (jm) {
                var jobName = jm[1].trim();
                lines.forEach(function (line, i) {
                    if (new RegExp('^\\s*' + jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:').test(line)) {
                        mark(i, 'job упал: ' + jobName);
                    }
                });
            }
        }
        if (hintCtx && hintCtx.needDispatch && !/workflow_dispatch/.test(content)) {
            // mark near on:
            for (var i = 0; i < lines.length; i++) {
                if (/^\s*on\s*:/.test(lines[i])) { mark(i, 'добавьте workflow_dispatch'); break; }
            }
            if (!Object.keys(marks).length) mark(0, 'нужен workflow_dispatch');
        }
        return marks;
    }

    function openYamlEditor(opts) {
        // opts: { title, path, content, branch, message, hintCtx }
        return new Promise(function (resolve) {
            var w = $('modalWrap');
            w.textContent = '';
            w.classList.add('ye-open');
            var c = el('div', 'mcard ye-mcard');
            c.appendChild(el('h3', '', opts.title || 'YAML'));
            var meta = el('div', 'ye-meta',
                'Путь: ' + (opts.path || '') + '\nНужны Contents: Read and write. Подсветка YAML · ошибки подсвечены в номерах строк.');
            c.appendChild(meta);

            var hints = yamlHints(opts.content || '', opts.hintCtx || {});
            var errLines = findErrorLines(opts.content || '', opts.hintCtx || {});
            if (hints.length || Object.keys(errLines).length) {
                var hb = el('div', 'ye-hints' + (Object.keys(errLines).length ? ' err' : ''));
                var parts = hints.slice();
                Object.keys(errLines).forEach(function (ln) {
                    parts.push('Строка ' + (parseInt(ln, 10) + 1) + ': ' + errLines[ln]);
                });
                hb.textContent = parts.join('\n');
                c.appendChild(hb);
            }

            var fields = el('div', 'ye-fields');
            var fBranch = el('div', 'fld');
            fBranch.appendChild(el('label', '', 'Ветка'));
            var inBranch = document.createElement('input');
            inBranch.type = 'text'; inBranch.value = opts.branch || branch || 'main';
            fBranch.appendChild(inBranch);
            var fMsg = el('div', 'fld');
            fMsg.appendChild(el('label', '', 'Коммит'));
            var inMsg = document.createElement('input');
            inMsg.type = 'text';
            inMsg.value = opts.message || ('Update ' + ((opts.path || '').split('/').pop() || 'workflow'));
            fMsg.appendChild(inMsg);
            fields.appendChild(fBranch);
            fields.appendChild(fMsg);
            c.appendChild(fields);

            var ed = el('div', 'ye-editor');
            var gutter = el('div', 'ye-gutter');
            var code = el('div', 'ye-code');
            var hl = el('pre', 'ye-hl');
            var ta = document.createElement('textarea');
            ta.className = 'ye-ta';
            ta.spellcheck = false;
            ta.setAttribute('autocapitalize', 'off');
            ta.setAttribute('autocomplete', 'off');
            ta.setAttribute('autocorrect', 'off');
            ta.value = opts.content || '';
            code.appendChild(hl);
            code.appendChild(ta);
            ed.appendChild(gutter);
            ed.appendChild(code);
            c.appendChild(ed);

            var status = el('div', 'ye-status');
            var stLeft = el('span', '', '');
            var stRight = el('span', '', '');
            status.appendChild(stLeft);
            status.appendChild(stRight);
            c.appendChild(status);

            function render() {
                var text = ta.value;
                var lines = text.split('\n');
                var marks = findErrorLines(text, opts.hintCtx || {});
                // gutter
                var g = '';
                for (var i = 0; i < lines.length; i++) {
                    g += '<span class="' + (marks[i] ? 'err' : '') + '" title="' +
                        (marks[i] ? String(marks[i]).replace(/"/g, '&quot;') : '') + '">' + (i + 1) + '</span>';
                }
                if (!lines.length) g = '<span>1</span>';
                gutter.innerHTML = g;
                // highlight
                var html;
                try {
                    if (window.Highlight && text.length < 120000) {
                        html = window.Highlight.highlight(text, opts.path || 'x.yml');
                    } else if (window.Highlight) {
                        html = window.Highlight.esc(text);
                    } else {
                        html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
                    }
                } catch (e) {
                    html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
                }
                // wrap error lines
                if (Object.keys(marks).length) {
                    var hlLines = html.split('\n');
                    Object.keys(marks).forEach(function (ln) {
                        var i = parseInt(ln, 10);
                        if (hlLines[i] != null) {
                            hlLines[i] = '<span class="err-line">' + hlLines[i] + '</span>';
                        }
                    });
                    html = hlLines.join('\n');
                }
                hl.innerHTML = html + '\n';
                // sync height
                ta.style.height = 'auto';
                var h = Math.max(code.clientHeight, ta.scrollHeight);
                ta.style.height = h + 'px';
                hl.style.minHeight = h + 'px';
                var errN = Object.keys(marks).length;
                stLeft.textContent = 'Строк: ' + lines.length + (errN ? (' · ошибок: ' + errN) : '');
                stRight.textContent = 'YAML · ' + (text.length) + ' симв.';
            }

            var raf = 0;
            function schedule() {
                if (raf) return;
                raf = requestAnimationFrame(function () { raf = 0; render(); });
            }
            ta.addEventListener('input', schedule);
            ta.addEventListener('scroll', function () {
                hl.style.transform = 'translate(' + (-ta.scrollLeft) + 'px,' + (-ta.scrollTop) + 'px)';
                gutter.scrollTop = ta.scrollTop;
            });
            // gutter scroll with code box
            code.addEventListener('scroll', function () {
                gutter.scrollTop = code.scrollTop;
            });

            var bar = el('div', 'mbtns');
            function close(val) {
                w.classList.add('hidden');
                w.classList.remove('ye-open');
                w.textContent = '';
                resolve(val);
            }
            var bCancel = el('button', 'mb', 'Отмена');
            bCancel.onclick = function () { close(null); };
            var bSave = el('button', 'mb primary', 'Сохранить');
            bSave.onclick = function () {
                var content = ta.value;
                if (!content.trim()) { U.toast('Файл пустой'); return; }
                var marks = findErrorLines(content, opts.hintCtx || {});
                var pre = yamlHints(content, opts.hintCtx || {});
                if (Object.keys(marks).length || pre.length) {
                    var msg = pre.join('\n');
                    Object.keys(marks).forEach(function (ln) {
                        msg += (msg ? '\n' : '') + 'Строка ' + (parseInt(ln, 10) + 1) + ': ' + marks[ln];
                    });
                    // confirm still save
                    U.confirmBox('Замечания по YAML', msg + '\n\nВсё равно сохранить?', 'Сохранить', false).then(function (ok) {
                        if (!ok) { render(); return; }
                        close({
                            branch: inBranch.value.trim() || 'main',
                            message: inMsg.value.trim() || ('Update ' + (opts.path || 'workflow')),
                            content: content
                        });
                    });
                    return;
                }
                close({
                    branch: inBranch.value.trim() || 'main',
                    message: inMsg.value.trim() || ('Update ' + (opts.path || 'workflow')),
                    content: content
                });
            };
            bar.appendChild(bCancel);
            bar.appendChild(bSave);
            c.appendChild(bar);
            w.appendChild(c);
            w.classList.remove('hidden');
            w.onclick = function (e) { if (e.target === w) close(null); };
            setTimeout(function () {
                render();
                try { ta.focus(); } catch (e) {}
                // scroll to first error
                var marks = findErrorLines(ta.value, opts.hintCtx || {});
                var first = Object.keys(marks).map(Number).sort(function (a, b) { return a - b; })[0];
                if (first != null) {
                    var lineH = 12 * 1.45;
                    ta.scrollTop = Math.max(0, first * lineH - 40);
                    code.scrollTop = ta.scrollTop;
                    gutter.scrollTop = ta.scrollTop;
                }
            }, 30);
        });
    }

    async function saveFile(path, title, initial, hintCtx) {
        var result = await U.run('Чтение файла…', function () { return getFile(path); });
        if (!result.ok) return;
        var current = result.v;
        var baseText = current.exists ? current.text : (initial || '');
        try {
            var draftRaw = localStorage.getItem('unzipgit_yaml_draft:' + path);
            if (draftRaw) {
                var dr = JSON.parse(draftRaw);
                if (dr && dr.content && Date.now() - (dr.ts || 0) < 7 * 864e5) {
                    var use = await U.confirmBox('Локальный черновик', 'Найден несохранённый черновик YAML. Открыть его?', 'Черновик', false);
                    if (use) baseText = dr.content;
                }
            }
        } catch (e) {}
        var form = await openYamlEditor({
            title: title || ('YAML: ' + path),
            path: path,
            content: baseText,
            branch: branch || 'main',
            message: current.exists ? ('Update ' + path.split('/').pop()) : ('Add ' + path.split('/').pop()),
            hintCtx: hintCtx || (lastRunHint && lastRunHint.path === path ? { failedSummary: lastRunHint.text } : null)
        });
        if (!form) return;
        var content = form.content;
        var payload = {
            message: form.message || ('Update ' + path),
            content: b64encode(content),
            branch: form.branch || branch || 'main'
        };
        if (current.exists) payload.sha = current.sha;
        var saved = await U.run('Сохранение…', async function () {
            var x = await api('PUT', '/contents/' + path.split('/').map(encodeURIComponent).join('/'), payload);
            if (!x.ok) {
                var msg = await handleApiFail(x, 'Contents: Read and write; проверьте защиту ветки.', 'contents');
                throw new Error(msg);
            }
            return true;
        });
        if (saved.ok) {
            lastRunHint = null;
            try { localStorage.removeItem('unzipgit_yaml_draft:' + path); } catch (e) {}
            U.toast('Сохранено в GitHub');
            load();
        } else if (form && form.content) {
            try {
                localStorage.setItem('unzipgit_yaml_draft:' + path, JSON.stringify({
                    content: form.content, message: form.message, branch: form.branch, ts: Date.now()
                }));
                U.toast('Черновик сохранён локально');
            } catch (e) {}
        }
    }
    async function editWorkflow(path, name, hintCtx) {
        if (!path) { U.toast('Нет пути workflow'); return; }
        await saveFile(path, 'YAML: ' + name, '', hintCtx);
    }

    async function createWorkflow() {
        var templates = [
            { id: 'empty', name: 'Пустой (workflow_dispatch)', body: 'name: New workflow\non:\n  workflow_dispatch:\n\njobs:\n  example:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "Hello"\n' },
            { id: 'android', name: 'Android APK (Gradle)', body: 'name: Android APK Build\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-java@v4\n        with:\n          distribution: temurin\n          java-version: \'17\'\n          cache: gradle\n      - run: chmod +x ./gradlew\n      - run: ./gradlew --no-daemon assembleDebug\n      - uses: actions/upload-artifact@v4\n        with:\n          name: UnzipGit-debug-apk\n          path: app/build/outputs/apk/debug/*.apk\n' },
            { id: 'node', name: 'Node.js CI', body: 'name: Node CI\non:\n  workflow_dispatch:\n  push:\n    branches: [ main ]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: \'20\'\n          cache: npm\n      - run: npm ci\n      - run: npm test\n' },
            { id: 'expo', name: 'Expo / React Native (EAS stub)', body: 'name: Expo Build Stub\non:\n  workflow_dispatch:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: \'20\'\n      - run: npm ci\n      - run: npx expo export --platform web || echo "настройте EAS secrets"\n' },
            { id: 'termux', name: 'Termux bootstrap (custom)', body: 'name: Termux bootstrap\non:\n  workflow_dispatch:\n    inputs:\n      architecture:\n        description: aarch64 or arm\n        default: aarch64\njobs:\n  bootstrap:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Build\n        run: |\n          set -Eeuo pipefail\n          echo "architecture=${{ github.event.inputs.architecture }}"\n          # добавьте свои scripts/…\n' }
        ];
        var tid = await U.sheet('Шаблон workflow', templates.map(function (t) {
            return { id: t.id, icon: 'play', label: t.name };
        }));
        if (!tid) return;
        var tpl = null;
        for (var i = 0; i < templates.length; i++) if (templates[i].id === tid) { tpl = templates[i]; break; }
        if (!tpl) return;
        var form = await U.form('Новый workflow', null, [
            { id: 'name', label: 'Имя файла (без .yml)', type: 'text', value: tid === 'empty' ? 'main' : tid, placeholder: 'ci' }
        ], 'Далее', function (x) {
            if (!/^[A-Za-z0-9._-]+$/.test((x.name || '').trim())) return 'Только латиница, цифры, ._-';
            return '';
        });
        if (!form) return;
        var name = form.name.trim().replace(/\.ya?ml$/i, '');
        await saveFile('.github/workflows/' + name + '.yml', 'Создать: ' + name, tpl.body);
    }
    async function deleteWorkflow(path, name) {
        if (!path) return;
        var ok = await U.confirmBox('Удалить YAML?', path + ' будет удалён коммитом. История Git останется.', 'Удалить', true);
        if (!ok) return;
        var r = await U.run('Удаление…', async function () {
            var f = await getFile(path);
            if (!f.exists) throw new Error('Файл уже отсутствует');
            var x = await api('DELETE', '/contents/' + path.split('/').map(encodeURIComponent).join('/'), {
                message: 'Delete ' + path, sha: f.sha, branch: branch || 'main'
            });
            if (!x.ok) throw new Error(U.errMsg(x, 'Contents: Read and write'));
            return true;
        });
        if (r.ok) { U.toast('Workflow удалён'); load(); }
    }

    async function setWorkflowState(w, enable) {
        var ok = await U.confirmBox(
            enable ? 'Включить workflow?' : 'Выключить workflow?',
            (w.name || w.path) + (enable ? ' будет включён.' : ' перестанет запускаться.'),
            enable ? 'Включить' : 'Выключить',
            !enable
        );
        if (!ok) return;
        var r = await U.run(enable ? 'Включение…' : 'Выключение…', async function () {
            var x = await api('PUT', '/actions/workflows/' + encodeURIComponent(w.id) + '/' + (enable ? 'enable' : 'disable'));
            if (!x.ok) {
                var msg = U.errMsg(x, 'Actions: Read and write');
                if (x.status === 401 || x.status === 403) await askPerms('actions_write', msg);
                throw new Error(msg);
            }
            return true;
        });
        if (r.ok) { U.toast(enable ? 'Включён' : 'Выключен'); load(); }
    }

    // ---------- загрузка ----------

    function stopAutoRefresh() {
        if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    }
    function scheduleAutoRefresh() {
        stopAutoRefresh();
        var active = runs.some(function (r) {
            return r.status && r.status !== 'completed';
        });
        if (!active) return;
        autoRefreshTimer = setInterval(function () {
            if (document.hidden) return;
            loadQuiet();
        }, 12000);
    }
    async function loadQuiet() {
        if (!owner || !repo) return;
        try {
            var r = await api('GET', '/actions/runs?per_page=30');
            if (r.ok && r.data) {
                runs = r.data.workflow_runs || [];
                detectFinishedRuns(runs);
                render();
                scheduleAutoRefresh();
            }
        } catch (e) { /* ignore quiet errors */ }
    }

    async function load() {
        if (!owner || !repo) {
            $('repoLabel').textContent = 'Репозиторий не выбран';
            showError('Сначала выберите репозиторий на экране «Репозитории».');
            actionsEnabled = null;
            renderActionsStatus();
            return;
        }
        $('repoLabel').textContent = owner + '/' + repo;
        showError('');
        var result = await U.run('Загрузка Actions…', async function () {
            // 1) Права Actions на репозиторий
            var perm = await api('GET', '/actions/permissions');
            var enabled = null;
            var permMsg = '';
            if (perm.ok && perm.data) {
                enabled = !!perm.data.enabled;
                if (perm.data.allowed_actions) {
                    permMsg = 'Разрешённые actions: ' + perm.data.allowed_actions +
                        (enabled ? '' : '. Actions выключены в настройках репозитория.');
                }
            } else if (perm.status === 404 || perm.status === 403) {
                // 404/403 на permissions — часто нет admin-прав; пробуем workflows
                permMsg = 'Нет доступа к настройкам Actions (нужен admin). Проверяем workflows…';
            } else if (!perm.ok) {
                permMsg = U.errMsg(perm, 'Не удалось прочитать /actions/permissions');
            }

            var w = await api('GET', '/actions/workflows?per_page=100&state=all');
            if (!w.ok) {
                // Если workflows 404/403 — скорее Actions недоступны
                if (w.status === 404 || w.status === 410) {
                    enabled = false;
                    permMsg = 'GitHub сообщает, что Actions недоступны для этого репозитория (HTTP ' + w.status + ').';
                } else if (w.status === 403) {
                    var msgW = U.errMsg(w, 'Нужны права Actions: Read (или Read and write).');
                    await askPerms('actions_read', msgW);
                    throw new Error(msgW);
                } else {
                    throw new Error(U.errMsg(w, 'Не удалось загрузить workflows.'));
                }
            }
            // Если permissions сказал enabled, оставляем; если null и workflows ok — считаем включёнными
            if (enabled === null && w.ok) enabled = true;

            var r = await api('GET', '/actions/runs?per_page=30');
            if (!r.ok && r.status !== 404) {
                // runs могут не открыться при узких правах — не валим весь экран
                if (r.status === 403) {
                    return {
                        enabled: enabled,
                        permMsg: permMsg || 'Workflows загружены, runs недоступны (нужен Actions: Read).',
                        workflows: (w.data && w.data.workflows) || [],
                        runs: []
                    };
                }
                throw new Error(U.errMsg(r, 'Не удалось загрузить запуски.'));
            }
            return {
                enabled: enabled,
                permMsg: permMsg,
                workflows: (w.data && w.data.workflows) || [],
                runs: (r.data && r.data.workflow_runs) || []
            };
        });
        if (!result.ok) {
            showError('Не удалось загрузить Actions. ' + (result.error && result.error.message || 'Проверьте интернет и токен.'));
            actionsEnabled = null;
            actionsPermMsg = '';
            renderActionsStatus();
            return;
        }
        actionsEnabled = result.v.enabled;
        actionsPermMsg = result.v.permMsg || '';
        workflows = result.v.workflows || [];
        runs = result.v.runs || [];
        // первичный снимок статусов — без тостов
        (runs || []).forEach(function (r) {
            prevRunStatus[String(r.id)] = (r.status || '') + '|' + (r.conclusion || '');
        });
        // Runs есть, workflows пусто (удалён YAML / API) — карточки из запусков
        if (!workflows.length && runs.length) {
            workflows = synthesizeWorkflowsFromRuns(runs);
        }
        renderActionsStatus();
        render();
        scheduleAutoRefresh();
    }

    function synthesizeWorkflowsFromRuns(runList) {
        var map = {};
        (runList || []).forEach(function (r) {
            var id = r.workflow_id != null ? String(r.workflow_id) : '';
            if (!id) return;
            if (!map[id]) {
                map[id] = {
                    id: r.workflow_id,
                    name: r.name || ('Workflow #' + id),
                    path: r.path || '',
                    state: 'active',
                    badge_url: '',
                    html_url: r.html_url || '',
                    _fromRuns: true
                };
            } else if (!map[id].path && r.path) {
                map[id].path = r.path;
            }
        });
        return Object.keys(map).map(function (k) { return map[k]; });
    }

    async function loadRunsForWorkflow(w) {
        var result = await U.run('Запуски workflow…', async function () {
            var r = await api('GET', '/actions/workflows/' + encodeURIComponent(w.id) + '/runs?per_page=30');
            if (!r.ok) throw new Error(U.errMsg(r));
            return (r.data && r.data.workflow_runs) || [];
        });
        if (!result.ok) return;
        runs = result.v;
        runFilter = 'all';
        U.toast('Запуски: ' + (w.name || w.path));
        render();
    }

    // ---------- dispatch / rerun / cancel / delete ----------
    async function dispatch(w) {
        if (actionsEnabled === false) {
            U.toast('Actions выключены в репозитории');
            return;
        }
        var fields = [{ id: 'branch', label: 'Ветка / ref', type: 'text', value: branch, placeholder: 'main' }];
        var form = await U.form(
            'Запустить',
            (w.name || w.path) + '\nВ YAML должен быть trigger workflow_dispatch.',
            fields,
            'Запустить',
            function (v) { return !(v.branch || '').trim() ? 'Укажите ветку' : ''; }
        );
        if (!form) return;
        var ref = (form.branch || branch || 'main').trim();
        var lastOpError = '';
        var r = await U.run('Запуск…', async function () {
            var x = await api('POST', '/actions/workflows/' + encodeURIComponent(w.id) + '/dispatches', { ref: ref });
            if (!x.ok) {
                var msg = U.errMsg(x, 'Нужен workflow_dispatch в YAML и Actions: Read and write.');
                lastOpError = msg;
                if (x.status === 401 || x.status === 403) {
                    await askPerms(classifyPermError(x.status, msg) || 'actions_write', msg);
                }
                throw new Error(msg);
            }
            return true;
        });
        if (r.ok) { U.toast('Запуск отправлен'); setTimeout(load, 1500); return; }
        if (w.path) {
            var fix = await U.confirmBox(
                'Исправить workflow?',
                (lastOpError || 'Запуск не удался.') +
                '\n\nОткрыть YAML с подсказками (workflow_dispatch, on, jobs)?',
                'Открыть YAML',
                false
            );
            if (fix) {
                await editWorkflow(w.path, w.name || w.path, {
                    dispatchFailed: true,
                    needDispatch: true,
                    apiError: lastOpError
                });
            }
        }
    }
    async function rerun(rn) {
        var ok = await U.confirmBox('Повторить?', 'Run #' + rn.run_number + ' будет запущен снова.', 'Повторить');
        if (!ok) return;
        var r = await U.run('Повтор…', async function () {
            var x = await api('POST', '/actions/runs/' + encodeURIComponent(rn.id) + '/rerun');
            if (!x.ok) {
                var msg = U.errMsg(x, 'Actions: Read and write');
                if (x.status === 401 || x.status === 403) await askPerms('actions_write', msg);
                throw new Error(msg);
            }
            return true;
        });
        if (r.ok) { U.toast('Повтор отправлен'); setTimeout(load, 1200); }
    }
    async function rerunFailed(rn) {
        var ok = await U.confirmBox('Только failed jobs?', 'Run #' + rn.run_number + ': перезапуск упавших заданий.', 'Повторить failed');
        if (!ok) return;
        var r = await U.run('Повтор failed…', async function () {
            var x = await api('POST', '/actions/runs/' + encodeURIComponent(rn.id) + '/rerun-failed-jobs');
            if (!x.ok) {
                var msg = U.errMsg(x, 'Actions: Read and write');
                if (x.status === 401 || x.status === 403) await askPerms('actions_write', msg);
                throw new Error(msg);
            }
            return true;
        });
        if (r.ok) { U.toast('Failed jobs перезапущены'); setTimeout(load, 1200); }
    }
    async function cancel(rn) {
        var ok = await U.confirmBox('Остановить?', 'Отменить run #' + rn.run_number + '?', 'Отменить', true);
        if (!ok) return;
        var r = await U.run('Отмена…', async function () {
            var x = await api('POST', '/actions/runs/' + encodeURIComponent(rn.id) + '/cancel');
            if (!x.ok) {
                var msg = U.errMsg(x, 'Actions: Read and write');
                if (x.status === 401 || x.status === 403) await askPerms('actions_write', msg);
                throw new Error(msg);
            }
            return true;
        });
        if (r.ok) { U.toast('Отмена отправлена'); setTimeout(load, 1000); }
    }
    async function deleteRun(rn) {
        var ok = await U.confirmBox('Удалить run?', '#' + rn.run_number + ' исчезнет из истории. Необратимо.', 'Удалить', true);
        if (!ok) return;
        var r = await U.run('Удаление…', async function () {
            var x = await api('DELETE', '/actions/runs/' + encodeURIComponent(rn.id));
            if (!x.ok) {
                var msg = U.errMsg(x, 'Actions: Read and write');
                if (x.status === 401 || x.status === 403) await askPerms('actions_write', msg);
                throw new Error(msg);
            }
            return true;
        });
        if (r.ok) { U.toast('Удалён'); load(); }
    }

    // ---------- jobs ----------
    async function openJobs(rn) {
        var result = await U.run('Задания…', async function () {
            var x = await api('GET', '/actions/runs/' + encodeURIComponent(rn.id) + '/jobs?per_page=100');
            if (!x.ok) throw new Error(U.errMsg(x));
            return x.data && x.data.jobs || [];
        });
        if (!result.ok) return;
        var jobs = result.v;
        if (!jobs.length) {
            await U.modal({ title: 'Jobs #' + rn.run_number, text: 'Заданий нет.', buttons: [{ label: 'Закрыть', val: 'ok', kind: 'primary' }] });
            return;
        }
        var items = jobs.map(function (j) {
            var st = statusLabel({ status: j.status, conclusion: j.conclusion });
            return {
                id: String(j.id),
                icon: j.conclusion === 'success' ? 'check' : (j.conclusion === 'failure' ? 'close' : 'upload'),
                label: j.name + ' — ' + st
            };
        });
        items.push({ id: '_all', icon: 'sort', label: 'Все детали текстом' });
        if (rn.conclusion === 'failure' || rn.conclusion === 'timed_out') {
            items.push({ id: '_fix', icon: 'edit', label: 'Исправить YAML по ошибке' });
        }
        if (rn.html_url) items.push({ id: '_gh', icon: 'open', label: 'Run на GitHub' });

        var chosen = await U.sheet('Jobs #' + rn.run_number, items);
        if (!chosen) return;
        if (chosen === '_gh') { U.openExternal(rn.html_url); return; }
        if (chosen === '_fix') { await fixWorkflowFromRun(rn); return; }
        if (chosen === '_all') {
            var lines = jobs.map(function (j) {
                return j.name + ' — ' + (j.status || '') + (j.conclusion ? ' / ' + j.conclusion : '') +
                    '\n' + date(j.started_at) + ' → ' + date(j.completed_at) +
                    (j.html_url ? '\n' + j.html_url : '');
            });
            await U.modal({ title: 'Jobs #' + rn.run_number, text: lines.join('\n\n'), buttons: [{ label: 'Закрыть', val: 'ok', kind: 'primary' }] });
            return;
        }
        var job = null;
        for (var i = 0; i < jobs.length; i++) if (String(jobs[i].id) === chosen) { job = jobs[i]; break; }
        if (!job) return;
        await showJobDetail(rn, job);
    }

    async function showJobDetail(rn, job) {
        var detail = job.name + '\n' + statusLabel({ status: job.status, conclusion: job.conclusion }) +
            '\n' + date(job.started_at) + ' → ' + date(job.completed_at);
        var failedSteps = [];
        if (job.steps && job.steps.length) {
            detail += '\n\nШаги:\n' + job.steps.map(function (s, idx) {
                var mark = (s.conclusion === 'failure' || s.conclusion === 'timed_out') ? '✗ ' :
                    (s.conclusion === 'success' ? '✓ ' : '· ');
                if (s.conclusion === 'failure' || s.conclusion === 'timed_out') failedSteps.push(s.name);
                return mark + (idx + 1) + '. ' + s.name + ' — ' + (s.conclusion || s.status || '');
            }).join('\n');
        }
        if (failedSteps.length) {
            detail += '\n\nУпавшие шаги: ' + failedSteps.join(', ');
        }
        var buttons = [
            { label: 'Закрыть', val: 'close' },
            { label: 'Лог (текст)', val: 'logtext' },
            { label: 'Лог на GitHub', val: 'log' }
        ];
        if (rn.conclusion === 'failure' || failedSteps.length) {
            buttons.push({ label: 'Исправить YAML', val: 'fix', kind: 'primary' });
        }
        var ans = await U.modal({ title: 'Job: ' + job.name, text: detail, buttons: buttons });
        if (!ans) return;
        if (ans.val === 'log' && job.html_url) U.openExternal(job.html_url);
        else if (ans.val === 'fix') await fixWorkflowFromRun(rn);
        else if (ans.val === 'logtext') await fetchAndShowJobLog(job);
    }

    async function fetchAndShowJobLog(job) {
        var result = await U.run('Загрузка лога…', async function () {
            // API отдаёт redirect на plain text; fetch обычно следует за ним
            var url = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' +
                encodeURIComponent(repo) + '/actions/jobs/' + encodeURIComponent(job.id) + '/logs';
            var headers = {
                'Authorization': 'token ' + U.token(),
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            };
            var text = '';
            if (window.AndroidInterface && typeof window.AndroidInterface.httpRequest === 'function') {
                var raw = window.AndroidInterface.httpRequest(JSON.stringify({
                    url: url, method: 'GET', headers: headers, body: null, binary: false
                }));
                var d = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (!d.ok && d.status !== 200) {
                    throw new Error((d.body && String(d.body).slice(0, 200)) || ('HTTP ' + d.status));
                }
                text = d.body || '';
            } else {
                var res = await fetch(url, { method: 'GET', headers: headers });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                text = await res.text();
            }
            if (!text || text.length < 8) throw new Error('Пустой лог или редирект не развернут. Откройте лог на GitHub.');
            return text;
        });
        if (!result.ok) {
            if (job.html_url) {
                var go = await U.confirmBox('Лог недоступен в приложении', 'Открыть полный лог на GitHub?', 'Открыть', false);
                if (go) U.openExternal(job.html_url);
            }
            return;
        }
        var text = result.v;
        var lines = text.split(/\r?\n/);
        async function showLogView(filter) {
            var showLines = lines;
            if (filter) {
                var q = filter.toLowerCase();
                showLines = lines.filter(function (ln, i) {
                    if (ln.toLowerCase().indexOf(q) >= 0) return true;
                    // контекст ±1
                    if (i > 0 && lines[i - 1].toLowerCase().indexOf(q) >= 0) return true;
                    if (i + 1 < lines.length && lines[i + 1].toLowerCase().indexOf(q) >= 0) return true;
                    return false;
                });
                if (!showLines.length) showLines = ['(нет совпадений для «' + filter + '»)'];
            }
            var body = filter
                ? showLines.slice(0, 200).join('\n')
                : lines.slice(-120).join('\n');
            if (body.length > 14000) body = body.slice(-14000);
            var buttons = [
                { label: 'Закрыть', val: 'close' },
                { label: 'Найти…', val: 'search' },
                { label: 'Хвост (ошибки)', val: 'tail' },
                { label: 'GitHub', val: 'gh', kind: 'primary' }
            ];
            var ans = await U.modal({
                title: 'Лог: ' + (job.name || 'job') + (filter ? ' · «' + filter + '»' : ' (хвост)'),
                text: body,
                buttons: buttons
            });
            if (!ans) return;
            if (ans.val === 'gh' && job.html_url) U.openExternal(job.html_url);
            else if (ans.val === 'search') {
                var f = await U.form('Поиск в логе', null, [
                    { id: 'q', label: 'Строка', type: 'text', placeholder: 'error, FAILED, npm…', value: filter || '' }
                ], 'Найти');
                if (f && f.q) await showLogView(f.q.trim());
                else await showLogView(filter);
            } else if (ans.val === 'tail') await showLogView('');
        }
        await showLogView('');
    }


    async function showRepoSecrets() {
        var r = await U.run('Секреты…', async function () {
            var s = await api('GET', '/actions/secrets?per_page=100');
            if (!s.ok) {
                var msg = await handleApiFail(s, 'Secrets: Read (или admin)', 'admin');
                throw new Error(msg);
            }
            return (s.data && s.data.secrets) || [];
        });
        if (!r.ok) return;
        var list = r.v;
        if (!list.length) {
            await U.modal({ title: 'Secrets', text: 'Секретов нет (или нет прав видеть имена).\nЗначения GitHub никогда не отдаёт.', buttons: [{ label: 'OK', val: 'ok', kind: 'primary' }] });
            return;
        }
        var text = list.map(function (s) {
            return '• ' + s.name + (s.updated_at ? ' · ' + date(s.updated_at) : '');
        }).join('\n');
        await U.modal({ title: 'Secrets (только имена)', text: text + '\n\nЗначения скрыты GitHub.', buttons: [{ label: 'OK', val: 'ok', kind: 'primary' }] });
    }
    async function showRepoVariables() {
        var r = await U.run('Variables…', async function () {
            var s = await api('GET', '/actions/variables?per_page=100');
            if (!s.ok) {
                var msg = await handleApiFail(s, 'Variables: Read', 'admin');
                throw new Error(msg);
            }
            return (s.data && s.data.variables) || [];
        });
        if (!r.ok) return;
        var list = r.v;
        if (!list.length) {
            await U.modal({ title: 'Variables', text: 'Переменных нет.', buttons: [{ label: 'OK', val: 'ok', kind: 'primary' }] });
            return;
        }
        var text = list.map(function (v) {
            var val = v.value != null ? String(v.value) : '';
            if (val.length > 80) val = val.slice(0, 80) + '…';
            return '• ' + v.name + (val ? ' = ' + val : '');
        }).join('\n');
        await U.modal({ title: 'Variables', text: text, buttons: [{ label: 'OK', val: 'ok', kind: 'primary' }] });
    }
    async function showEnvironments() {
        var r = await U.run('Environments…', async function () {
            var s = await api('GET', '/environments?per_page=30');
            if (!s.ok) {
                var msg = await handleApiFail(s, 'Environments / admin', 'admin');
                throw new Error(msg);
            }
            return (s.data && s.data.environments) || [];
        });
        if (!r.ok) return;
        var list = r.v;
        if (!list.length) {
            await U.modal({ title: 'Environments', text: 'Окружений нет.', buttons: [{ label: 'OK', val: 'ok', kind: 'primary' }] });
            return;
        }
        var text = list.map(function (e) {
            var prot = (e.protection_rules && e.protection_rules.length) ? ' · защита: ' + e.protection_rules.length : '';
            return '• ' + e.name + prot;
        }).join('\n');
        await U.modal({ title: 'Environments', text: text, buttons: [{ label: 'OK', val: 'ok', kind: 'primary' }] });
    }

    // ---------- artifacts + скачивание ----------
    window.__ugProgress = function (id, sent, total) {
        var c = dlCb[id];
        if (c && c.progress) c.progress(sent, total);
    };
    window.__ugDownloadDone = function (id, ok, msg) {
        var c = dlCb[id];
        if (c) { delete dlCb[id]; c.done({ ok: !!ok, msg: msg || '' }); }
    };

    function artifactDownloadUrl(art) {
        // archive_download_url или собираем сами
        if (art.archive_download_url) return art.archive_download_url;
        return 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' +
            encodeURIComponent(repo) + '/actions/artifacts/' + encodeURIComponent(art.id) + '/zip';
    }

    async function downloadArtifact(art) {
        if (art.expired) { U.toast('Срок хранения истёк'); return; }
        var url = artifactDownloadUrl(art);
        var fileName = (art.name || 'artifact') + '.zip';
        // Нативное скачивание (как у релизов)
        if (N && typeof N.downloadAsset === 'function') {
            var id = 'art_' + art.id + '_' + Date.now();
            U.setBusy('Скачивание…');
            var res = await new Promise(function (resolve) {
                dlCb[id] = {
                    progress: function (s, t) {
                        $('busyTxt').textContent = 'Скачивание… ' +
                            (t > 0 ? Math.min(100, Math.floor(s * 100 / t)) + '%' : fmtSize(s));
                    },
                    done: resolve
                };
                try { N.downloadAsset(id, url, U.token(), fileName); }
                catch (e) { delete dlCb[id]; resolve({ ok: false, msg: String((e && e.message) || e) }); }
            });
            U.clearBusy();
            if (res.ok) U.toast('Артефакт сохранён');
            else if (res.msg && res.msg !== 'cancel') await U.showError('Не удалось скачать:\n' + res.msg);
            return;
        }
        // Fallback в браузере: открыть на GitHub (без нативного bridge)
        U.toast('Скачивание доступно в приложении Android');
        if (art.html_url) U.openExternal(art.html_url);
    }

    async function openArtifacts(rn) {
        var result = await U.run('Артефакты…', async function () {
            var x = await api('GET', '/actions/runs/' + encodeURIComponent(rn.id) + '/artifacts?per_page=100');
            if (!x.ok) throw new Error(U.errMsg(x));
            return x.data && x.data.artifacts || [];
        });
        if (!result.ok) return;
        var arts = result.v;
        if (!arts.length) { U.toast('Артефактов нет'); return; }

        var items = arts.map(function (a) {
            var size = fmtSize(a.size_in_bytes);
            return {
                id: String(a.id),
                icon: a.expired ? 'warn' : 'download',
                label: a.name + (size ? ' · ' + size : '') + (a.expired ? ' · истёк' : '')
            };
        });
        if (rn.html_url) items.push({ id: '_gh', icon: 'open', label: 'Run на GitHub' });

        var chosen = await U.sheet('Артефакты #' + rn.run_number, items);
        if (!chosen) return;
        if (chosen === '_gh') { U.openExternal(rn.html_url); return; }

        var art = null;
        for (var i = 0; i < arts.length; i++) if (String(arts[i].id) === chosen) { art = arts[i]; break; }
        if (!art) return;

        if (art.expired) {
            await U.modal({
                title: art.name,
                text: 'Срок хранения артефакта истёк (HTTP 410 при скачивании).\nСкачать нельзя — запустите workflow снова.',
                buttons: [{ label: 'Закрыть', val: 'ok', kind: 'primary' }]
            });
            return;
        }

        var fileName = (art.name || 'artifact') + '.zip';
        var ans = await U.modal({
            title: 'Скачать артефакт',
            text: 'Имя файла: ' + fileName +
                '\nРазмер: ' + fmtSize(art.size_in_bytes) +
                '\nСоздан: ' + date(art.created_at) +
                '\n\nОткроется системное окно «Сохранить как…».',
            buttons: [
                { label: 'Отмена', val: 'close' },
                { label: 'Скачать ZIP', val: 'dl', kind: 'primary' }
            ]
        });
        if (ans && ans.val === 'dl') await downloadArtifact(art);
    }

    // ---------- bind ----------
    // иконки в шапке
    Array.prototype.forEach.call(document.querySelectorAll('[data-i]'), function (n) {
        try { n.innerHTML = window.MI(n.getAttribute('data-i'), 22); } catch (e) { /* ignore */ }
    });

    // Включить Actions на уровне репозитория (нужен admin)
    async function enableRepoActions() {
        var ok = await U.confirmBox(
            'Включить Actions?',
            'Будет включён GitHub Actions для репозитория ' + owner + '/' + repo + '.\nНужны права admin (Administration: Read and write).',
            'Включить',
            false
        );
        if (!ok) return;
        var r = await U.run('Включение Actions…', async function () {
            var x = await api('PUT', '/actions/permissions', { enabled: true });
            if (!x.ok) {
                var msg = U.errMsg(x, 'Нужны права администратора репозитория (Administration: Write).');
                await askPerms('admin', msg);
                throw new Error(msg);
            }
            return true;
        });
        if (r.ok) { U.toast('Actions включены'); load(); }
    }

    $('createWfBtn').onclick = createWorkflow;
    $('editBuildBtn').onclick = function () {
        saveFile('.github/workflows/android.yml', 'android.yml',
            'name: Android APK Build\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-java@v4\n        with:\n          distribution: temurin\n          java-version: \'17\'\n          cache: gradle\n      - run: chmod +x ./gradlew\n      - run: ./gradlew --no-daemon assembleDebug\n      - uses: actions/upload-artifact@v4\n        with:\n          name: UnzipGit-debug-apk\n          path: app/build/outputs/apk/debug/*.apk\n');
    };
    $('backBtn').onclick = function () { U.goto('repos.html'); };
    $('refreshBtn').onclick = load;
    if ($('secBtn')) $('secBtn').onclick = showRepoSecrets;
    if ($('varBtn')) $('varBtn').onclick = showRepoVariables;
    if ($('envBtn')) $('envBtn').onclick = showEnvironments;
    if ($('themeBtn')) $('themeBtn').onclick = function () { U.cycleTheme && U.cycleTheme(); };
    if (U.applyTheme) U.applyTheme();

    window.__onBack = function () {
        if (U.isModalOpen()) {
            var w = $('modalWrap');
            if (w && w.classList.contains('ye-open')) {
                w.classList.add('hidden');
                w.classList.remove('ye-open');
                w.textContent = '';
                return true;
            }
            U.modalCancel();
            return true;
        }
        if (U.isSheetOpen()) { U.closeSheet(); return true; }
        if (U.isBusy()) return true;
        return false;
    };
    window.addEventListener('pagehide', stopAutoRefresh);
    window.addEventListener('visibilitychange', function () {
        if (document.hidden) stopAutoRefresh();
        else scheduleAutoRefresh();
    });
    load();
})();
