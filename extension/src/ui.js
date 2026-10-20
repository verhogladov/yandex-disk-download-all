/*
 * Интерфейс: плавающая кнопка «Скачать» на странице Диска и панель с настройками
 * и прогрессом. Всё живёт в закрытом Shadow DOM, чтобы не конфликтовать со стилями сайта.
 */
(function (root) {
  'use strict';
  const YDD = (root.YDD = root.YDD || {});
  const { t, formatBytes, formatCount, formatDuration } = YDD;

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.wrap {
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "YS Text", "Helvetica Neue", Arial, sans-serif;
  --bg: #ffffff; --fg: #1d2129; --muted: #6a717d; --border: #e3e6eb; --soft: #f3f5f8;
  --accent: #3a5ae8; --accent-hover: #2f4dd4; --on-accent: #ffffff;
  --warn-bg: #fff5d9; --warn-fg: #5f4500; --err: #c62828; --ok: #23824a; --shadow: rgba(16, 24, 40, .22);
  font: 14px/1.45 var(--font); color: var(--fg);
  color-scheme: light;
}
.wrap.dark {
  color-scheme: dark; /* галочки, переключатели и полосы прокрутки — тоже тёмные */
  --bg: #1f2125; --fg: #e9eaee; --muted: #a0a6b0; --border: #34373d; --soft: #2a2d33;
  --accent: #6582ff; --accent-hover: #7590ff; --on-accent: #0d1020;
  --warn-bg: #3a3221; --warn-fg: #f2d483; --err: #ff7a7a; --ok: #6fd391; --shadow: rgba(0, 0, 0, .5);
}
button { font: inherit; color: inherit; }
.fab {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 18px 0 14px;
  border: 0; border-radius: 22px; background: var(--accent); color: var(--on-accent);
  font: 600 14px/1 var(--font); cursor: pointer; box-shadow: 0 6px 18px var(--shadow);
  max-width: calc(100vw - 40px); white-space: nowrap;
}
.fab:hover { background: var(--accent-hover); }
.fab:focus-visible, .btn:focus-visible, .link:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 2px; }
.fab svg { width: 20px; height: 20px; flex: none; }
.fab .label { overflow: hidden; text-overflow: ellipsis; }
.panel {
  position: fixed; right: 20px; bottom: 76px; z-index: 2147483001;
  width: min(410px, calc(100vw - 24px)); max-height: calc(100vh - 100px); overflow: auto;
  background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 14px;
  box-shadow: 0 16px 48px var(--shadow);
}
@media (max-width: 480px) { .panel { right: 12px; left: 12px; width: auto; } .fab { right: 12px; } }
.panel[hidden] { display: none; }
header { display: flex; align-items: center; gap: 8px; padding: 14px 16px 10px; position: sticky; top: 0; background: var(--bg); z-index: 1; }
header .title { font-weight: 650; font-size: 15px; flex: 1; }
.close { border: 0; background: transparent; width: 30px; height: 30px; border-radius: 8px; cursor: pointer; font-size: 20px; line-height: 1; color: var(--muted); }
.close:hover { background: var(--soft); color: var(--fg); }
.body { padding: 0 16px 16px; display: grid; gap: 12px; }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.section-title { font-weight: 600; margin-bottom: 6px; }
.choices { display: grid; gap: 6px; }
.choice { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; }
.choice:hover { background: var(--soft); }
.choice input { margin: 3px 0 0; accent-color: var(--accent); flex: none; }
.choice .t { font-weight: 550; overflow-wrap: anywhere; }
.choice .s { font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere; }
.check { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
.check input { margin: 3px 0 0; accent-color: var(--accent); flex: none; }
details.settings summary { cursor: pointer; color: var(--muted); }
details.settings .grid { display: grid; gap: 10px; padding-top: 10px; }
.field { display: grid; gap: 4px; }
.field input[type=text], .field select {
  font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px;
}
.note { background: var(--soft); border-radius: 10px; padding: 10px 12px; font-size: 13px; }
.note.warn { background: var(--warn-bg); color: var(--warn-fg); }
.note.err { background: color-mix(in srgb, var(--err) 12%, var(--bg)); color: var(--fg); border: 1px solid color-mix(in srgb, var(--err) 35%, transparent); }
.note p { margin: 0 0 6px; } .note p:last-child { margin: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.btn {
  border: 1px solid var(--border); background: var(--bg); border-radius: 10px; padding: 8px 14px; cursor: pointer; font-weight: 550;
}
.btn:hover { background: var(--soft); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.btn.primary:hover { background: var(--accent-hover); }
.btn.wide { width: 100%; padding: 11px 14px; font-size: 15px; }
.btn:disabled { opacity: .55; cursor: default; }
.link { border: 0; background: none; padding: 0; color: var(--accent); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; font-size: 13px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.badge { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--soft); color: var(--muted); white-space: nowrap; }
.badge.run { background: color-mix(in srgb, var(--accent) 16%, var(--bg)); color: var(--accent); }
.badge.ok { background: color-mix(in srgb, var(--ok) 16%, var(--bg)); color: var(--ok); }
.job-title { font-weight: 600; flex: 1; overflow-wrap: anywhere; }
.bar { height: 8px; border-radius: 99px; background: var(--soft); overflow: hidden; }
.bar-fill { height: 100%; width: 0; background: var(--accent); border-radius: 99px; transition: width .4s ease; }
.bar.indeterminate .bar-fill { width: 30% !important; animation: slide 1.4s ease-in-out infinite; }
@keyframes slide { 0% { margin-left: -30%; } 100% { margin-left: 100%; } }
.big { font-size: 15px; font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-size: 12.5px; padding: 3px 9px; border-radius: 999px; background: var(--soft); }
.chip.ok { color: var(--ok); } .chip.err { color: var(--err); } .chip.warn { color: var(--warn-fg); background: var(--warn-bg); }
ul.active, ul.errlist { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
ul.active li, ul.errlist li { display: flex; gap: 8px; font-size: 12.5px; min-width: 0; }
ul.active .n, ul.errlist .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
ul.active .p { color: var(--muted); white-space: nowrap; }
ul.errlist .m { color: var(--err); flex: 1.3; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
details.errs summary { cursor: pointer; color: var(--muted); font-size: 13px; }
details.errs ul { margin-top: 6px; }
.foot { border-top: 1px solid var(--border); padding-top: 10px; display: flex; gap: 14px; flex-wrap: wrap; }
.zipopts { display: grid; gap: 8px; margin: 0 0 4px 22px; padding: 10px 12px; border-radius: 10px; background: var(--soft); }
.picker { display: grid; gap: 10px; }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; font-size: 13px; color: var(--muted); }
.crumbs button { border: 0; background: none; padding: 3px 5px; border-radius: 6px; color: var(--accent); cursor: pointer; font: inherit; }
.crumbs button:hover { background: var(--soft); }
.crumbs .here { color: var(--fg); font-weight: 600; padding: 3px 5px; overflow-wrap: anywhere; }
ul.plist { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.pitem { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-top: 1px solid var(--border); min-height: 40px; }
.pitem:first-child { border-top: 0; }
.pitem input { accent-color: var(--accent); flex: none; margin: 0; width: 16px; height: 16px; }
.pname { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; border: 0; background: none; padding: 0; text-align: left; font: inherit; color: inherit; }
.pname > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.pname { cursor: pointer; }
button.pname:hover > span:last-child { text-decoration: underline; text-underline-offset: 2px; }
.pname .ic { display: inline-flex; flex: none; color: var(--muted); }
.pname .ic svg { width: 18px; height: 18px; }
.pname.dir .ic { color: var(--accent); }
.psize { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.pitem.implied .pname { color: var(--muted); }
.pempty { padding: 14px; color: var(--muted); text-align: center; font-size: 13px; }
.pfoot { position: sticky; bottom: 0; padding: 10px 0 2px; background: var(--bg); border-top: 1px solid var(--border); display: grid; gap: 8px; }
details.psel summary { cursor: pointer; font-weight: 600; }
details.psel ul { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 2px; max-height: 132px; overflow: auto; }
details.psel li { display: flex; gap: 8px; align-items: center; font-size: 12.5px; min-width: 0; }
details.psel li span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tgroups { display: grid; gap: 8px; }
.tgroup { border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; }
.trow { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tname { font-weight: 600; }
.tmore { margin: 2px 0 0 24px; }
ul.texts { list-style: none; margin: 6px 0 2px 24px; padding: 0; display: grid; gap: 4px; }
ul.texts li { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ename { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size: 13px; }
.zipopts p { margin: 0; }
.lang { font: inherit; font-size: 12.5px; color: var(--muted); background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 3px 4px; max-width: 128px; cursor: pointer; }
`;

  const ICON_DIR =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.8l2.2 2.5h7A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>';
  const ICON_FILE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/></svg>';

  const ICON_DOWN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const ISSUES_URL = 'https://github.com/verhogladov/yandex-disk-download-all/issues';
  /**
   * Сколько готово, в процентах: по числу обработанных файлов или по скачанным байтам — что больше.
   * Одно большое видео иначе всё время показывало бы «0 %», а тысячи мелких файлов,
   * часть которых Яндекс не отдаёт, — застревали бы по байтам.
   */
  const progressPct = (s) => {
    const processed = s.done + s.preview + s.failed + s.confirm + s.skipped + (s.zipped || 0);
    const byFiles = s.total ? processed / s.total : 0;
    const byBytes = s.totalBytes > 0 ? Math.min(1, (s.bytesDone || 0) / s.totalBytes) : 0;
    return Math.max(byFiles, byBytes) * 100;
  };
  const extLabel = (ext) => (ext ? '.' + ext : t('ext.none'));
  /** «a, b, c и ещё 4». */
  const listMore = (items, limit = 3) =>
    items.length > limit ? t('list.more', { list: items.slice(0, limit).join(', '), n: items.length - limit }) : items.join(', ');

  class Ui {
    constructor(app) {
      this.app = app;
      this.isOpen = false;
      this.view = null;
      this.refs = null;
      this.actionsKey = '';
      // Отмеченное вручную в окне выбора: путь → файл или папка. Живёт, пока открыта страница.
      this.picked = new Map();
      this.pickerPath = null;
      this.setupAfterJob = false;
    }

    mount() {
      const host = document.createElement('ydd-download-all');
      host.style.cssText = 'all: initial; position: static;';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      this.wrap = h('div', { class: 'wrap' });
      this.fab = h('button', { class: 'fab', type: 'button', onclick: () => this.toggle() });
      this.fab.innerHTML = ICON_DOWN;
      this.fabLabel = h('span', { class: 'label' });
      this.fab.append(this.fabLabel);
      this.body = h('div', { class: 'body' });
      this.titleEl = h('div', { class: 'title' });
      this.closeBtn = h('button', { class: 'close', type: 'button', text: '×', onclick: () => this.close() });
      // Язык интерфейса — прямо в заголовке, чтобы его нашёл и тот, кто не читает по-русски.
      this.langSel = h('select', { class: 'lang' });
      for (const l of YDD.i18n.LANGS) this.langSel.append(h('option', { value: l.code, text: l.name }));
      this.langSel.addEventListener('change', () => this.app.setLang(this.langSel.value));
      this.panel = h('section', { class: 'panel', hidden: true, role: 'dialog' }, h('header', null, this.titleEl, this.langSel, this.closeBtn), this.body);
      this.wrap.append(this.fab, this.panel);
      shadow.append(style, this.wrap);
      // Рядом с <body>, а не внутри: сайт перерисовывает содержимое body.
      document.documentElement.append(host);
      this.host = host;
      this.applyTheme();
      this.relabel();
    }

    /** Подписи, которые не перерисовываются вместе с содержимым панели. Вызывается и при смене языка. */
    relabel() {
      this.fab.title = t('app.title');
      this.titleEl.textContent = t('app.title');
      this.panel.setAttribute('aria-label', t('app.title'));
      this.closeBtn.setAttribute('aria-label', t('app.close'));
      this.langSel.setAttribute('aria-label', t('app.language'));
      this.langSel.title = t('app.language');
      this.langSel.value = YDD.i18n.lang;
      this.refreshFab();
    }

    /** Язык сменили — перерисовываем то, что сейчас открыто, сохранив отмеченное. */
    rerender() {
      this.relabel();
      if (!this.isOpen) return;
      if (this.view === 'setup') {
        const restore = this.readSetupForm();
        this.showSetup({ afterJob: this.setupAfterJob, restore, scope: restore.scope || null });
      } else if (this.view === 'picker') {
        const before = this.pickedBefore;
        this.showPicker();
        if (before) this.pickedBefore = before;
      } else if (this.view === 'types') this.showTypes();
      else if (this.view === 'confirm') this.confirmNew();
      else this.open();
    }

    applyTheme() {
      let dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      try {
        const bg = getComputedStyle(document.body).backgroundColor;
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(bg);
        if (m && (m[4] === undefined || Number(m[4]) > 0.5)) {
          const lum = (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
          dark = lum < 0.45;
        }
      } catch (e) {
        /* оставляем системную тему */
      }
      this.wrap.classList.toggle('dark', !!dark);
    }

    open() {
      this.isOpen = true;
      this.panel.hidden = false;
      this.applyTheme();
      const snap = this.app.engine.snapshot();
      if (snap.job && snap.blocked && snap.blocked.kind === 'filter') this.showTypes();
      else if (snap.job) this.showProgress();
      else this.showSetup();
    }

    close() {
      this.isOpen = false;
      this.panel.hidden = true;
      this.view = null;
    }

    toggle() {
      if (this.isOpen) this.close();
      else this.open();
    }

    /** Вызывается при любом изменении состояния движка. */
    update(snap) {
      this.refreshFab(snap);
      if (!this.isOpen) return;
      if (this.view === 'progress') {
        if (!snap.job) this.showSetup();
        else if (snap.blocked && snap.blocked.kind === 'filter' && this.typesShownFor !== snap.job.id) {
          // Все файлы найдены — один раз сами показываем выбор типов.
          this.typesShownFor = snap.job.id;
          this.showTypes();
        } else this.updateProgress(snap);
      }
    }

    refreshFab(snap) {
      const s = snap || this.app.engine.snapshot();
      let label;
      if (this.app.dead) label = t('fab.reload');
      else if (s.job) {
        // 100 % — только когда задание действительно закончено.
        const pct = Math.min(99, Math.floor(progressPct(s)));
        if (s.job.phase === 'running') {
          if (s.scanning && !s.total) label = t('fab.scanning');
          else if (s.zip && s.zip.waiting && !s.pending && !s.scanning) label = t('fab.savingZip');
          else label = t('fab.running', { pct });
        } else if (s.job.phase === 'done') label = s.failed ? t('fab.doneErrors', { n: s.failed }) : t('fab.done');
        else if (s.blocked && s.blocked.kind === 'filter') label = t('fab.chooseTypes');
        else label = s.blocked ? t('fab.action') : t('fab.paused', { pct });
      } else {
        const info = this.app.pageInfo();
        if (info.kind === 'public') label = t('fab.public');
        else if (info.selection.length) label = t('fab.selection', { n: info.selection.length });
        else if (info.folder && info.folder !== '/disk') label = t('fab.folder');
        else label = t('fab.all');
      }
      if (this.fabLabel.textContent !== label) this.fabLabel.textContent = label;
    }

    // --- Выбор, что скачивать ----------------------------------------------------
    showSetup({ afterJob = false, restore = null, scope = null } = {}) {
      this.view = 'setup';
      this.refs = null;
      this.pickRefs = null;
      this.actionsKey = '';
      this.setupAfterJob = afterJob;
      const info = this.app.pageInfo();
      const s = Object.assign({}, YDD.DEFAULT_OPTIONS, this.app.settings);
      const choices = [];
      if (info.kind === 'public') {
        choices.push({
          value: 'public',
          title: info.title ? t('scope.public', { title: info.title }) : t('scope.publicNoTitle'),
          sub: info.path && info.path !== '/' ? t('scope.publicFolder', { path: info.path }) : t('scope.withSubfolders'),
        });
      } else {
        const sp = info.space;
        choices.push({
          value: 'all',
          title: t('scope.all'),
          // Это оценка Яндекса: в число файлов входит и корзина, а она не скачивается. Точное число — после поиска.
          sub: sp && sp.files_count ? `≈ ${t('count.files', { n: sp.files_count })} · ${formatBytes(Math.max(0, (sp.used || 0) - (sp.trash || 0)))}` : t('scope.allSub'),
        });
        if (info.folder && info.folder !== '/disk') {
          choices.push({ value: 'folder', title: t('scope.folder', { name: info.folderName }), sub: t('scope.withSubfolders') });
        }
        if (info.selection.length) {
          choices.push({
            value: 'selection',
            title: t('scope.selection', { n: info.selection.length }),
            sub: listMore(info.selection.map((x) => x.name)),
          });
        }
      }
      const picked = [...this.picked.values()];
      if (picked.length) {
        choices.push({ value: 'pick', title: t('scope.picked', { summary: this.pickTotals().text }), sub: listMore(picked.map((x) => x.name)) });
      } else {
        choices.push({ value: 'pick', title: t('scope.pick'), sub: t('scope.pickSub') });
      }
      const preferred =
        (scope && choices.find((c) => c.value === scope)) ||
        choices.find((c) => c.value === 'selection') ||
        (picked.length && choices.find((c) => c.value === 'pick')) ||
        choices.find((c) => c.value === 'folder') ||
        choices[0];
      const radios = choices.map((c) =>
        h(
          'label',
          { class: 'choice' },
          h('input', { type: 'radio', name: 'scope', value: c.value, checked: c === preferred }),
          h('div', null, h('div', { class: 't', text: c.title }), c.sub ? h('div', { class: 's', text: c.sub }) : null)
        )
      );
      const unlim =
        info.kind === 'private' && info.unlim
          ? h(
              'label',
              { class: 'check' },
              h('input', { type: 'checkbox', name: 'unlim', checked: true }),
              h('span', null, t('setup.unlim') + ' ', h('span', { class: 'muted small', text: t('setup.unlimNote') }))
            )
          : null;
      const syncUnlim = () => {
        if (!unlim) return;
        const checked = this.body.querySelector('input[name=scope]:checked');
        unlim.hidden = !checked || checked.value !== 'all';
      };
      for (const r of radios) r.querySelector('input').addEventListener('change', syncUnlim);
      const pickLink = h('button', { class: 'link', type: 'button', text: t('setup.changePick'), onclick: () => this.showPicker() });
      const syncPick = () => {
        const checked = this.body.querySelector('input[name=scope]:checked');
        pickLink.hidden = !checked || checked.value !== 'pick' || !this.picked.size;
      };
      for (const r of radios) {
        const input = r.querySelector('input');
        input.addEventListener('change', () => {
          syncPick();
          // Выбрали «Выбрать файлы и папки», а выбранного ещё нет — сразу открываем список.
          if (input.value === 'pick' && input.checked && !this.picked.size) this.showPicker();
        });
      }
      const typeChoice = (value, title, sub) =>
        h(
          'label',
          { class: 'choice' },
          h('input', { type: 'radio', name: 'types', value, checked: value === 'all' }),
          h('div', null, h('div', { class: 't', text: title }), h('div', { class: 's', text: sub }))
        );
      const typesBlock = h(
        'div',
        null,
        h('div', { class: 'section-title', text: t('setup.types') }),
        h('div', { class: 'choices' }, typeChoice('all', t('types.all'), t('types.allSub')), typeChoice('ask', t('types.ask'), t('types.askSub')))
      );
      const skipDone = afterJob
        ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'skipDone', checked: true }), h('span', { text: t('setup.skipDone') }))
        : null;

      // Куда сохранять: на компьютер или в подключённое облако/на сервер.
      const dest = this.app.dest && this.app.dest.type && this.app.dest.type !== 'local' ? this.app.dest : null;
      const initialDest = s.lastZip ? 'zip' : dest ? 'remote' : 'local';
      const destChoice = (value, title, sub) =>
        h(
          'label',
          { class: 'choice' },
          h('input', { type: 'radio', name: 'dest', value, checked: value === initialDest }),
          h('div', null, h('div', { class: 't', text: title }), h('div', { class: 's', text: sub }))
        );
      const partSel = h('select', { name: 'zipPart' });
      // Чуть меньше 1/2/4 ГБ: часть «4 ГБ» должна поместиться на флешку с FAT32 (предел — 4 ГБ без байта).
      for (const [mb, gb] of [[1000, 1], [2000, 2], [4000, 4]]) {
        partSel.append(h('option', { value: String(mb), selected: (Number(s.zipPartMB) || 2000) === mb, text: `${formatCount(gb)} ${t('unit.GB')}` }));
      }
      const zipOpts = h(
        'div',
        { class: 'zipopts' },
        h('label', { class: 'field' }, h('span', { text: t('zip.partLabel') }), partSel),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'zipPackAll', checked: !!s.zipPackAll }), h('span', { text: t('zip.packAll') })),
        h('p', { class: 'muted small' }, t('zip.note'))
      );
      // Настройки архива — сразу под его пунктом.
      const destChoices = [
        destChoice('local', t('dest.local'), t('dest.localSub')),
        destChoice('zip', t('dest.zip'), t('dest.zipSub')),
        zipOpts,
      ];
      if (dest) destChoices.push(destChoice('remote', dest.label, t('dest.remoteSub')));
      const destBlock = h(
        'div',
        null,
        h('div', { class: 'section-title', text: t('setup.where') }),
        h('div', { class: 'choices' }, destChoices),
        h(
          'div',
          { style: 'margin-top:8px' },
          h('button', {
            class: 'link',
            type: 'button',
            text: dest ? t('dest.change') : t('dest.connect'),
            onclick: () => this.app.bg.openOptions(),
          })
        )
      );

      const conc = h('select', { name: 'concurrency' });
      for (const n of [1, 2, 3, 4, 6, 8]) conc.append(h('option', { value: String(n), selected: Number(s.concurrency) === n, text: String(n) }));
      const rootInput = h('input', { type: 'text', name: 'root', value: this.app.settings.root || t('fs.root'), maxlength: '60', spellcheck: 'false' });
      const settings = h(
        'details',
        { class: 'settings' },
        h('summary', { text: t('settings.title') }),
        h(
          'div',
          { class: 'grid' },
          h('label', { class: 'field' }, h('span', { text: t('settings.concurrency') }), conc),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'preview', checked: !!s.preview }), h('span', { text: t('settings.preview') })),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'eraseHistory', checked: !!s.eraseHistory }), h('span', { text: t('settings.eraseHistory') })),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'quietUi', checked: !!s.quietUi }), h('span', { text: t('settings.quietUi') })),
          h('label', { class: 'field' }, h('span', { text: t('settings.root') }), rootInput)
        )
      );
      const error = h('div', { class: 'note err', hidden: true });
      const startBtn = h('button', { class: 'btn primary wide', type: 'button', text: t('setup.start') });
      const localWarning = h(
        'div',
        { class: 'note warn' },
        h('p', null, h('b', { text: t('setup.warnTitle') + ' ' }), t('setup.warn')),
        h('button', { class: 'link', type: 'button', text: t('setup.openDownloadSettings'), onclick: () => this.app.bg.openSettings() })
      );
      const howNote = h('p');
      // Перевод с русского: просим присылать исправления. В русском словаре строка пустая.
      const translationNote = t('translation.note');
      const form = h(
        'div',
        { class: 'body-inner', style: 'display:grid;gap:12px' },
        h('div', null, h('div', { class: 'section-title', text: t('setup.what') }), h('div', { class: 'choices' }, radios), h('div', { style: 'margin-top:6px' }, pickLink)),
        unlim,
        skipDone,
        typesBlock,
        destBlock,
        settings,
        localWarning,
        h(
          'div',
          { class: 'note' },
          howNote,
          h('p', { text: t('setup.keepTab') })
        ),
        error,
        startBtn,
        translationNote &&
          h(
            'p',
            { class: 'muted small translation', style: 'margin:0' },
            translationNote + ' ',
            h('a', { class: 'link small', href: ISSUES_URL, target: '_blank', rel: 'noopener', text: 'GitHub' })
          )
      );
      const syncDest = () => {
        const kind = (form.querySelector('input[name=dest]:checked') || {}).value;
        localWarning.hidden = kind !== 'local';
        zipOpts.hidden = kind !== 'zip';
        if (kind === 'remote') howNote.textContent = t('how.remote', { name: dest.label });
        else if (kind === 'zip') howNote.textContent = t('how.zip', { part: partSel.options[partSel.selectedIndex].text });
        else howNote.textContent = t('how.local');
      };
      // Вернулись из окна выбора — восстанавливаем то, что было отмечено в форме.
      if (restore) {
        for (const el of form.querySelectorAll('input[name], select[name]')) {
          if (el.name === 'scope' || !(el.name in restore)) continue;
          if (el.type === 'radio') el.checked = restore[el.name] === el.value;
          else if (el.type === 'checkbox') el.checked = !!restore[el.name];
          else el.value = restore[el.name];
        }
        if (!form.querySelector('input[name=dest]:checked')) form.querySelector('input[name=dest][value=local]').checked = true;
      }
      for (const input of form.querySelectorAll('input[name=dest]')) input.addEventListener('change', syncDest);
      partSel.addEventListener('change', syncDest);
      syncDest();
      startBtn.addEventListener('click', async () => {
        const scope = (form.querySelector('input[name=scope]:checked') || {}).value;
        const kind = (form.querySelector('input[name=dest]:checked') || {}).value;
        const remote = kind === 'remote';
        const zipPartMB = Number(partSel.value) || 2000;
        const zipPackAll = form.querySelector('input[name=zipPackAll]').checked;
        const opts = {
          concurrency: Number(conc.value) || 4,
          preview: form.querySelector('input[name=preview]').checked,
          eraseHistory: form.querySelector('input[name=eraseHistory]').checked,
          quietUi: form.querySelector('input[name=quietUi]').checked,
          root: (YDD.sanitizeComponent(rootInput.value.trim() || t('fs.root')) || 'Yandex Disk').slice(0, 60),
          dest:
            kind === 'zip'
              ? { type: 'zip', label: t('dest.zipLabel'), partMB: zipPartMB, packAll: zipPackAll }
              : remote && dest
                ? { type: dest.type, label: dest.label }
                : { type: 'local' },
        };
        const extra = {
          unlim: !!(unlim && unlim.querySelector('input').checked && scope === 'all'),
          skipDone: !!(skipDone && skipDone.querySelector('input').checked),
          picked: scope === 'pick' ? [...this.picked.values()] : null,
          typeFilter: (form.querySelector('input[name=types]:checked') || {}).value === 'ask' ? 'ask' : null,
        };
        startBtn.disabled = true;
        error.hidden = true;
        try {
          const remember = Object.assign({}, opts, { lastZip: kind === 'zip', zipPartMB, zipPackAll });
          delete remember.dest;
          await this.app.saveSettings(remember);
          await this.app.startNew(scope, opts, extra);
          this.showProgress();
        } catch (e) {
          error.textContent = (e && e.message) || String(e);
          error.hidden = false;
          startBtn.disabled = false;
        }
      });
      this.body.replaceChildren(form);
      syncUnlim();
      syncPick();
    }

    /** Значения полей формы настройки — чтобы вернуть их после окна выбора. */
    readSetupForm() {
      const state = {};
      for (const el of this.body.querySelectorAll('input[name], select[name]')) {
        if (el.type === 'radio') {
          if (el.checked) state[el.name] = el.value;
        } else if (el.type === 'checkbox') state[el.name] = el.checked;
        else state[el.name] = el.value;
      }
      return state;
    }

    // --- Выбор файлов и папок вручную ------------------------------------------------
    pickTotals() {
      let dirs = 0;
      let files = 0;
      let bytes = 0;
      for (const it of this.picked.values()) {
        if (it.type === 'dir') dirs++;
        else {
          files++;
          bytes += it.size || 0;
        }
      }
      return { dirs, files, bytes, text: YDD.pickSummary(dirs, files) };
    }

    /** Отмечена ли папка выше — тогда этот файл или папка и так войдут в загрузку. */
    pickImplied(path) {
      for (const [p, it] of this.picked) if (it.type === 'dir' && path.startsWith(p + '/')) return true;
      return false;
    }

    pickSet(item, on) {
      if (on) {
        // Отметили папку — отдельные отметки внутри неё больше не нужны.
        for (const p of [...this.picked.keys()]) if (p.startsWith(item.id + '/')) this.picked.delete(p);
        this.picked.set(item.id, {
          id: item.id,
          name: item.name,
          type: item.type === 'dir' ? 'dir' : 'file',
          size: item.size == null ? null : item.size,
          mediaType: item.mediaType || null,
          mtime: item.mtime || 0,
          partial: !!item.partial,
        });
      } else this.picked.delete(item.id);
    }

    showPicker() {
      if (this.view === 'setup') this.setupState = this.readSetupForm();
      this.pickedBefore = new Map(this.picked);
      const info = this.app.pageInfo();
      this.pickerRoot = info.browse.root;
      this.pickerTitle = info.browse.title;
      const inside = (p) => p === this.pickerRoot || p.startsWith(this.pickerRoot === '/' ? '/' : this.pickerRoot + '/');
      if (!this.pickerPath || !inside(this.pickerPath)) this.pickerPath = inside(info.browse.start) ? info.browse.start : this.pickerRoot;
      this.view = 'picker';
      this.refs = null;
      const r = (this.pickRefs = {});
      r.crumbs = h('nav', { class: 'crumbs', 'aria-label': t('picker.nav') });
      r.whole = h('label', { class: 'check', hidden: true }, h('input', { type: 'checkbox', name: 'pickWhole' }), h('span'));
      r.whole.querySelector('input').addEventListener('change', (e) => {
        this.pickSet({ id: this.pickerPath, name: YDD.basename(this.pickerPath), type: 'dir' }, e.target.checked);
        this.renderPicker();
      });
      r.list = h('ul', { class: 'plist', 'aria-label': t('picker.list') });
      r.more = h('button', { class: 'btn', type: 'button', text: t('picker.more'), hidden: true, onclick: () => this.loadPickerPage() });
      r.error = h('div', { class: 'note err', hidden: true });
      r.summary = h('summary');
      r.selList = h('ul');
      r.sel = h('details', { class: 'psel' }, r.summary, r.selList);
      r.done = h('button', { class: 'btn primary', type: 'button', text: t('picker.done'), onclick: () => this.closePicker(true) });
      this.body.replaceChildren(
        h(
          'div',
          { class: 'picker' },
          h('p', { class: 'muted small', text: t('picker.hint') }),
          r.crumbs,
          r.whole,
          r.list,
          r.more,
          r.error,
          h('div', { class: 'pfoot' }, r.sel, h('div', { class: 'actions' }, r.done, h('button', { class: 'btn', type: 'button', text: t('common.cancel'), onclick: () => this.closePicker(false) })))
        )
      );
      this.openPickerFolder(this.pickerPath);
    }

    closePicker(apply) {
      if (!apply && this.pickedBefore) this.picked = this.pickedBefore;
      this.pickedBefore = null;
      this.showSetup({ afterJob: this.setupAfterJob, restore: this.setupState || null, scope: this.picked.size ? 'pick' : null });
    }

    openPickerFolder(path) {
      this.pickerPath = path;
      this.pickerItems = [];
      this.pickerCursor = null;
      this.pickerSeq = (this.pickerSeq || 0) + 1;
      this.renderPicker();
      this.loadPickerPage();
    }

    async loadPickerPage() {
      const seq = this.pickerSeq;
      const r = this.pickRefs;
      const first = !this.pickerItems.length && !this.pickerCursor;
      this.pickerLoading = true;
      r.more.disabled = true;
      r.error.hidden = true;
      this.renderPicker();
      try {
        const page = await this.app.browse(this.pickerPath, first ? null : this.pickerCursor);
        if (seq !== this.pickerSeq || this.pickRefs !== r) return;
        this.pickerItems.push(...page.items.filter((it) => it && it.id));
        this.pickerCursor = page.next || null;
      } catch (e) {
        if (seq !== this.pickerSeq || this.pickRefs !== r) return;
        r.error.replaceChildren(
          h('p', { text: t('picker.error', { error: (e && e.message) || e }) }),
          h('button', { class: 'link', type: 'button', text: t('picker.retry'), onclick: () => (first ? this.openPickerFolder(this.pickerPath) : this.loadPickerPage()) })
        );
        r.error.hidden = false;
      } finally {
        if (seq === this.pickerSeq && this.pickRefs === r) {
          this.pickerLoading = false;
          r.more.disabled = false;
          this.renderPicker();
        }
      }
    }

    renderPicker() {
      const r = this.pickRefs;
      if (!r) return;
      // «Хлебные крошки»: Диск › Фото › 2019
      const root = this.pickerRoot;
      const parts = this.pickerPath.slice(root.length).split('/').filter(Boolean);
      const crumbs = [{ label: this.pickerTitle, path: root }];
      let acc = root;
      for (const part of parts) {
        acc = acc === '/' ? '/' + part : acc + '/' + part;
        crumbs.push({ label: part, path: acc });
      }
      const nav = [];
      crumbs.forEach((c, i) => {
        if (i) nav.push(h('span', { 'aria-hidden': 'true', text: '›' }));
        nav.push(i === crumbs.length - 1 ? h('span', { class: 'here', text: c.label }) : h('button', { type: 'button', text: c.label, onclick: () => this.openPickerFolder(c.path) }));
      });
      r.crumbs.replaceChildren(...nav);

      // Вся текущая папка целиком
      const atRoot = this.pickerPath === root;
      const implied = this.pickImplied(this.pickerPath);
      const box = r.whole.querySelector('input');
      r.whole.hidden = atRoot;
      box.checked = implied || this.picked.has(this.pickerPath);
      box.disabled = implied;
      r.whole.querySelector('span').textContent = t('picker.whole', { name: YDD.basename(this.pickerPath) });

      const rows = this.pickerItems.map((it) => this.pickerRow(it));
      if (!rows.length && !(r.error && !r.error.hidden)) {
        rows.push(h('li', { class: 'pempty', text: this.pickerLoading ? t('picker.loading') : t('picker.empty') }));
      }
      r.list.replaceChildren(...rows);
      r.more.hidden = !this.pickerCursor;
      r.more.textContent = this.pickerLoading && this.pickerItems.length ? t('picker.loadingMore') : t('picker.more');

      // Что выбрано
      const sum = this.pickTotals();
      r.summary.textContent = !this.picked.size
        ? t('picker.nothing')
        : sum.files && !sum.dirs
          ? t('picker.selectedSize', { summary: sum.text, size: formatBytes(sum.bytes) })
          : t('picker.selected', { summary: sum.text });
      const shown = (path) => (path.slice(root.length).replace(/^\//, '') || this.pickerTitle);
      r.selList.replaceChildren(
        ...[...this.picked.values()].map((it) =>
          h(
            'li',
            null,
            h('span', { text: shown(it.id), title: shown(it.id) }),
            h('button', {
              class: 'link',
              type: 'button',
              text: t('picker.remove'),
              'aria-label': t('picker.removeAria', { name: it.name }),
              onclick: () => {
                this.pickSet(it, false);
                this.renderPicker();
              },
            })
          )
        )
      );
      r.sel.hidden = !this.picked.size;
      r.done.disabled = !this.picked.size;
    }

    pickerRow(it) {
      const implied = this.pickImplied(it.id);
      const box = h('input', { type: 'checkbox', checked: implied || this.picked.has(it.id), disabled: implied, 'aria-label': t('picker.selectAria', { name: it.name }) });
      box.addEventListener('change', () => {
        this.pickSet(it, box.checked);
        this.renderPicker();
      });
      const icon = h('span', { class: 'ic' });
      icon.innerHTML = it.type === 'dir' ? ICON_DIR : ICON_FILE;
      const label = h('span', { text: it.name, title: it.name });
      const name =
        it.type === 'dir'
          ? h('button', { class: 'pname dir', type: 'button', title: t('picker.openFolder'), onclick: () => this.openPickerFolder(it.id) }, icon, label)
          : h('span', { class: 'pname' }, icon, label);
      const size = h('span', { class: 'psize', text: it.type === 'dir' ? '›' : it.size != null ? formatBytes(it.size) : '' });
      return h('li', { class: 'pitem' + (implied ? ' implied' : ''), 'data-name': it.name }, box, name, size);
    }

    // --- Прогресс -----------------------------------------------------------------
    showProgress() {
      this.view = 'progress';
      this.actionsKey = '';
      const r = (this.refs = {});
      r.title = h('div', { class: 'job-title' });
      r.badge = h('span', { class: 'badge' });
      r.scan = h('div', { class: 'muted small' });
      r.barFill = h('div', { class: 'bar-fill' });
      r.bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, r.barFill);
      r.main = h('div', { class: 'big' });
      r.bytes = h('div', { class: 'muted small' });
      r.chips = h('div', { class: 'chips' });
      r.notice = h('div', { class: 'note warn', hidden: true });
      r.blocked = h('div', { class: 'note err', hidden: true });
      r.active = h('ul', { class: 'active' });
      r.errList = h('ul', { class: 'errlist' });
      r.errs = h('details', { class: 'errs', hidden: true }, h('summary', { text: t('progress.errors') }), r.errList);
      r.actions = h('div', { class: 'actions' });
      r.dest = h('div', { class: 'muted small', hidden: true });
      r.zip = h('div', { class: 'muted small', hidden: true });
      r.filterText = h('span');
      r.filterLink = h('button', { class: 'link', type: 'button', text: t('filter.change'), onclick: () => this.showTypes() });
      r.filter = h('div', { class: 'muted small', hidden: true }, r.filterText, ' ', r.filterLink);
      r.openFolder = h('button', { class: 'link', type: 'button', text: t('progress.openFolder'), onclick: () => this.app.bg.showFolder() });
      r.foot = h(
        'div',
        { class: 'foot' },
        r.openFolder,
        h('button', { class: 'link', type: 'button', text: t('progress.report'), onclick: () => this.app.downloadReport() })
      );
      this.body.replaceChildren(
        h('div', null, h('div', { class: 'row' }, r.title, r.badge), r.dest),
        r.bar,
        h('div', null, r.main, r.bytes),
        r.scan,
        r.filter,
        r.zip,
        r.chips,
        r.notice,
        r.blocked,
        r.active,
        r.errs,
        r.actions,
        r.foot
      );
      this.updateProgress(this.app.engine.snapshot());
    }

    updateProgress(s) {
      const r = this.refs;
      if (!r || !s.job) return;
      const job = s.job;
      const processed = s.done + s.preview + s.failed + s.confirm + s.skipped + (s.zipped || 0);
      const pct = job.phase === 'done' ? 100 : progressPct(s);
      r.title.textContent = job.scopeLabel;
      const zip = !!(job.dest && job.dest.type === 'zip');
      r.dest.textContent = !job.dest
        ? ''
        : zip && job.dest.name
          ? t('progress.whereZip', { label: job.dest.label, name: job.dest.name })
          : t('progress.where', { label: job.dest.label });
      r.dest.hidden = !job.dest;
      r.openFolder.hidden = !!job.dest && !zip;
      if (zip && s.zip) {
        let text;
        if (s.zip.parts === 1 && job.phase === 'done') text = t('zip.savedArchive', { size: formatBytes(s.zip.bytes), file: s.zip.files[0] });
        else if (s.zip.parts) text = t('zip.savedParts', { n: s.zip.parts, size: formatBytes(s.zip.bytes) });
        else text = job.phase !== 'done' ? t('zip.pending') : t('zip.empty');
        r.zip.textContent = text;
        r.zip.hidden = false;
      } else r.zip.hidden = true;
      const running = job.phase === 'running';
      const badge =
        job.phase === 'done'
          ? [t('badge.done'), 'badge ok']
          : running
            ? [s.scanning && !s.total ? t('badge.scanning') : t('badge.running'), 'badge run']
            : [s.blocked ? t('badge.stopped') : t('badge.paused'), 'badge'];
      r.badge.textContent = badge[0];
      r.badge.className = badge[1];
      r.bar.classList.toggle('indeterminate', running && s.scanning && !s.total);
      r.barFill.style.width = pct.toFixed(1) + '%';
      r.bar.setAttribute('aria-valuenow', String(Math.round(pct)));
      const more = s.scanning ? '+' : '';
      r.main.textContent = t('progress.count', { done: formatCount(processed), n: s.total, more });
      let bytes = t('progress.bytes', { done: formatBytes(s.bytesDone), total: formatBytes(s.totalBytes), more });
      if (running && s.speed > 0) bytes += ` · ${formatBytes(s.speed)}${t('unit.perSecond')}`;
      if (running && s.eta > 0) bytes += ` · ${t('progress.eta', { time: formatDuration(s.eta) })}`;
      r.bytes.textContent = bytes;

      const scanParts = [];
      if (s.scanning) scanParts.push(t('scan.dirs', { n: s.dirs }));
      if (s.unlim && s.unlim.state !== 'skip') {
        if (s.unlim.state === 'done') scanParts.push(t('unlim.done', { n: s.unlim.found || 0 }));
        else if (s.unlim.state === 'failed') scanParts.push(t('unlim.failed'));
        else if (s.unlim.active) scanParts.push(t('unlim.active', { n: s.unlim.found || 0 }));
        else scanParts.push(t('unlim.later'));
      }
      if (s.scanErrors.length) scanParts.push(t('scan.errors', { n: s.scanErrors.length }));
      r.scan.textContent = scanParts.join(' · ');
      r.scan.hidden = !scanParts.length;

      if (s.filter) {
        if (s.filter.pending) {
          r.filterText.textContent = s.scanning
            ? t('filter.scanning', { files: t('count.files', { n: s.found }), types: t('count.types', { n: s.typeCount }) })
            : t('filter.ready');
          r.filterLink.textContent = t('filter.choose');
          r.filterLink.hidden = s.scanning;
        } else {
          r.filterText.textContent = t('filter.only', { list: listMore(s.filter.exts.map(extLabel), 6) });
          r.filterLink.textContent = t('filter.change');
          r.filterLink.hidden = false;
        }
        r.filter.hidden = false;
      } else r.filter.hidden = true;

      const chips = [];
      if (s.done) chips.push(['ok', t(zip ? 'chip.doneZip' : 'chip.done', { n: s.done })]);
      if (s.zipped) chips.push(['', t('chip.zipped', { n: s.zipped })]);
      if (s.reused) chips.push(['', t('chip.reused', { n: s.reused })]);
      if (s.preview) chips.push(['warn', t('chip.preview', { n: s.preview })]);
      if (s.failed) chips.push(['err', t('chip.failed', { n: s.failed })]);
      if (s.confirm) chips.push(['warn', t('chip.confirm', { n: s.confirm })]);
      if (s.skipped) chips.push(['', t('chip.skipped', { n: s.skipped })]);
      if (s.excluded) chips.push(['', t('chip.excluded', { n: s.excluded })]);
      r.chips.replaceChildren(...chips.map(([cls, text]) => h('span', { class: 'chip ' + cls, text })));

      const notices = [];
      if (s.rateLimitedUntil) {
        const sec = Math.max(1, Math.round((s.rateLimitedUntil - Date.now()) / 1000));
        notices.push(t('notice.rateLimit', { sec }));
      }
      if (s.confirm) notices.push(t('notice.confirm'));
      if (s.storageError) notices.push(t('notice.storage', { error: s.storageError }));
      r.notice.replaceChildren(...notices.map((text) => h('p', { text })));
      r.notice.hidden = !notices.length;

      if (s.blocked) {
        r.blocked.replaceChildren(h('p', { text: s.blocked.message }));
        r.blocked.hidden = false;
      } else r.blocked.hidden = true;

      const stageText = (a) => {
        if (a.stage === 'link') return t('stage.link');
        if (a.stage === 'preview') return t('stage.preview');
        if (a.stage === 'zip') return a.total > 0 && a.received > 0 ? t('stage.zipPct', { pct: Math.min(100, Math.floor((a.received / a.total) * 100)) }) : t('stage.zip');
        if (a.stage === 'zip-saveas') return t('stage.zipSaveAs');
        if (a.stage === 'zip-confirm') return t('stage.zipConfirm');
        if (zip && a.busy) return t('stage.packing');
        if (job.dest && !zip && a.total > 0) {
          // Для облака прогресс общий: сначала скачивание с Яндекса, потом отправка.
          const half = a.total / 2;
          return a.received < half
            ? t('stage.fromYandex', { pct: Math.floor((a.received / half) * 100) })
            : t('stage.toCloud', { pct: Math.min(100, Math.floor(((a.received - half) / half) * 100)) });
        }
        if (a.total > 0) return `${Math.min(100, Math.floor((a.received / a.total) * 100))}%`;
        return a.received ? formatBytes(a.received) : t('stage.waiting');
      };
      r.active.replaceChildren(
        ...s.active.slice(0, 8).map((a) => h('li', null, h('span', { class: 'n', text: a.name, title: a.path || a.name }), h('span', { class: 'p', text: stageText(a) })))
      );
      r.active.hidden = !s.active.length;

      r.errList.replaceChildren(
        ...s.recentErrors.map((e) => h('li', null, h('span', { class: 'n', text: e.name, title: e.name }), h('span', { class: 'm', text: e.msg, title: e.msg })))
      );
      r.errs.hidden = !s.recentErrors.length;

      this.renderActions(s);
    }

    renderActions(s) {
      const job = s.job;
      const blockedKind = s.blocked ? s.blocked.kind : '';
      const key = [job.phase, blockedKind, s.failed, s.preview > 0, this.app.dead, YDD.i18n.lang].join('|');
      if (key === this.actionsKey) return;
      this.actionsKey = key;
      const e = this.app.engine;
      const btn = (text, onclick, cls = 'btn') => h('button', { class: cls, type: 'button', text, onclick });
      const buttons = [];
      if (this.app.dead) {
        buttons.push(btn(t('action.reload'), () => location.reload(), 'btn primary'));
      } else if (job.phase === 'running') {
        buttons.push(btn(t('action.pause'), () => e.pause()));
        buttons.push(btn(t('action.stop'), () => e.stop()));
      } else if (job.phase === 'done') {
        if (s.failed) buttons.push(btn(t('action.retryFailed', { n: s.failed }), () => e.retryFailed(), 'btn primary'));
        if (s.preview) buttons.push(btn(t('action.retryPreviews'), () => e.retryPreviews()));
        buttons.push(btn(t('action.new'), () => this.confirmNew()));
      } else if (blockedKind === 'filter') {
        buttons.push(btn(t('filter.choose'), () => this.showTypes(), 'btn primary'));
        buttons.push(btn(t('action.new'), () => this.confirmNew()));
      } else {
        const needsReload = blockedKind === 'auth' || blockedKind === 'locked' || blockedKind === 'dead';
        if (needsReload) {
          buttons.push(btn(t('action.reload'), () => location.reload(), 'btn primary'));
        } else {
          if (blockedKind === 'captcha' && s.blocked.url) {
            buttons.push(btn(t('action.captcha'), () => window.open(s.blocked.url, '_blank', 'noopener')));
          }
          if (blockedKind === 'saveas') buttons.push(btn(t('action.downloadSettings'), () => this.app.bg.openSettings()));
          if (blockedKind === 'dest') buttons.push(btn(t('action.cloudSettings'), () => this.app.bg.openOptions()));
          buttons.push(btn(t('action.continue'), () => e.start(), 'btn primary'));
        }
        // Пока задание идёт в другой вкладке, отсюда его не трогаем.
        if (blockedKind !== 'locked' && blockedKind !== 'dead') buttons.push(btn(t('action.new'), () => this.confirmNew()));
      }
      this.refs.actions.replaceChildren(...buttons);
    }

    // --- Выбор типов файлов ------------------------------------------------------------
    showTypes() {
      const engine = this.app.engine;
      const snap = engine.snapshot();
      if (!snap.job) return this.showSetup();
      this.view = 'types';
      this.refs = null;
      const stats = engine.typeStats();
      const chosen = new Set(snap.filter && !snap.filter.pending ? snap.filter.exts : []);

      const total = stats.reduce((a, g) => ({ count: a.count + g.count, bytes: a.bytes + g.bytes }), { count: 0, bytes: 0 });
      const extCount = stats.reduce((n, g) => n + g.exts.length, 0);
      const summary = h('div', { class: 'big' });
      const apply = h('button', { class: 'btn primary', type: 'button', text: t('types.apply') });
      const syncers = [];
      const sync = () => {
        syncers.forEach((fn) => fn());
        let count = 0;
        let bytes = 0;
        for (const g of stats) {
          for (const e of g.exts) {
            if (!chosen.has(e.ext)) continue;
            count += e.count;
            bytes += e.bytes;
          }
        }
        summary.textContent = chosen.size ? t('types.summary', { n: count, size: formatBytes(bytes) }) : t('types.choose');
        apply.disabled = !chosen.size;
      };
      const groups = stats.map((g) => {
        const gbox = h('input', { type: 'checkbox', 'data-group': g.id });
        const list = h('ul', { class: 'texts', hidden: true });
        const boxes = g.exts.map((e) => {
          const box = h('input', { type: 'checkbox', 'data-ext': e.ext });
          box.addEventListener('change', () => {
            if (box.checked) chosen.add(e.ext);
            else chosen.delete(e.ext);
            sync();
          });
          list.append(
            h(
              'li',
              { 'data-ext': e.ext },
              h('label', { class: 'check' }, box, h('span', { class: 'ename', text: extLabel(e.ext) })),
              h('span', { class: 'psize', text: `${formatCount(e.count)} · ${formatBytes(e.bytes)}` })
            )
          );
          return [e.ext, box];
        });
        gbox.addEventListener('change', () => {
          for (const [ext] of boxes) {
            if (gbox.checked) chosen.add(ext);
            else chosen.delete(ext);
          }
          sync();
        });
        syncers.push(() => {
          const n = boxes.filter(([ext]) => chosen.has(ext)).length;
          for (const [ext, box] of boxes) box.checked = chosen.has(ext);
          gbox.checked = n === boxes.length;
          gbox.indeterminate = n > 0 && n < boxes.length;
        });
        const preview = g.exts.slice(0, 4).map((e) => extLabel(e.ext)).join(', ') + (g.exts.length > 4 ? '…' : '');
        const more = h('button', { class: 'link', type: 'button', 'aria-expanded': 'false', text: `${t('count.types', { n: g.exts.length })}: ${preview}` });
        more.addEventListener('click', () => {
          list.hidden = !list.hidden;
          more.setAttribute('aria-expanded', String(!list.hidden));
        });
        return h(
          'div',
          { class: 'tgroup' },
          h('div', { class: 'trow' }, h('label', { class: 'check' }, gbox, h('span', { class: 'tname', text: t('group.' + g.id) })), h('span', { class: 'psize', text: `${formatCount(g.count)} · ${formatBytes(g.bytes)}` })),
          h('div', { class: 'tmore' }, more),
          list
        );
      });
      apply.addEventListener('click', () => {
        engine.applyFilter([...chosen]);
        this.showProgress();
        engine.start();
      });
      const markAll = (on) => {
        chosen.clear();
        if (on) for (const g of stats) for (const e of g.exts) chosen.add(e.ext);
        sync();
      };
      this.body.replaceChildren(
        h(
          'div',
          { class: 'picker' },
          h(
            'div',
            null,
            h('div', { class: 'section-title', text: t('types.title') }),
            h('p', {
              class: 'muted small',
              text: stats.length
                ? t('types.found', { files: t('count.files', { n: total.count }), size: formatBytes(total.bytes), types: t('count.types', { n: extCount }) })
                : t('types.none'),
            })
          ),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'link', type: 'button', text: t('types.markAll'), onclick: () => markAll(true) }),
            h('button', { class: 'link', type: 'button', text: t('types.clearAll'), onclick: () => markAll(false) })
          ),
          h('div', { class: 'tgroups' }, groups),
          h('div', { class: 'pfoot' }, summary, h('div', { class: 'actions' }, apply, h('button', { class: 'btn', type: 'button', text: t('common.back'), onclick: () => this.showProgress() })))
        )
      );
      sync();
    }

    confirmNew() {
      this.view = 'confirm';
      this.refs = null;
      const s = this.app.engine.snapshot();
      const unsaved = s.zipped || 0;
      this.body.replaceChildren(
        h(
          'div',
          { class: 'note' },
          h('p', { text: t('confirm.title') }),
          h('p', { text: t('confirm.kept') })
        ),
        unsaved
          ? h(
              'div',
              { class: 'note warn' },
              h('p', { text: t('confirm.zipLost', { n: unsaved }) })
            )
          : null,
        h(
          'div',
          { class: 'actions' },
          h('button', {
            class: 'btn primary',
            type: 'button',
            text: t('confirm.choose'),
            onclick: () => this.showSetup({ afterJob: true }),
          }),
          h('button', { class: 'btn', type: 'button', text: t('common.cancel'), onclick: () => this.showProgress() })
        )
      );
    }
  }

  Object.assign(YDD, { Ui });
})(typeof globalThis !== 'undefined' ? globalThis : this);
