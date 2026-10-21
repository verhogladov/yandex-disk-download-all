/*
 * Точка входа на страницах Яндекс Диска: собирает движок, источник данных и интерфейс.
 */
(async function () {
  'use strict';
  if (window.top !== window || window.__yddContent) return;
  window.__yddContent = true;
  const YDD = globalThis.YDD;
  const t = YDD.t;

  const isClient = location.pathname === '/client' || location.pathname.startsWith('/client/');
  const publicLink = YDD.PublicApi.parseLocation(location);
  if (!isClient && !publicLink) return;

  const app = { dead: false };
  let ui = null;
  let engine = null;

  // --- Связь с фоновым скриптом ---------------------------------------------------
  const changeListeners = new Set();
  function send(msg) {
    return new Promise((resolve) => {
      if (app.dead) return resolve({ ok: false, error: 'extension-reloaded' });
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          resolve(err ? { ok: false, error: err.message } : res || { ok: false, error: 'no-response' });
        });
      } catch (e) {
        // Расширение обновили или отключили — эта копия скрипта больше не работает.
        app.dead = true;
        resolve({ ok: false, error: 'extension-reloaded' });
        if (engine) {
          engine.block({ kind: 'dead', message: t('err.extReloaded') });
        }
      }
    });
  }
  const bg = {
    startDownload: (o) => send({ type: 'dl:start', url: o.url, filename: o.filename, headers: o.headers, timeoutMs: o.timeoutMs }),
    startTransfer: (o) => send({ type: 'dl:start', remote: true, url: o.url, filename: o.filename, headers: o.headers, size: o.size, lang: YDD.i18n.lang }),
    startZip: (o) => send(Object.assign({ type: 'dl:start', zip: true, lang: YDD.i18n.lang }, o)),
    zipSave: (o) => send({ type: 'zip:save', jobId: o.jobId, n: o.n, filename: o.filename }),
    zipState: (jobId) => send({ type: 'zip:state', jobId }),
    zipSeal: (jobId) => send({ type: 'zip:seal', jobId }),
    zipRelease: (jobId, n) => send({ type: 'zip:release', jobId, n }),
    zipDrop: (jobId) => send({ type: 'zip:drop', jobId }),
    openOptions: () => send({ type: 'open:options' }),
    status: (ids) => send({ type: 'dl:status', ids }),
    cancel: (id) => send({ type: 'dl:cancel', id }),
    erase: (id) => send({ type: 'dl:erase', id }),
    sweep: (since) => send({ type: 'dl:sweep', since }),
    showFolder: () => send({ type: 'dl:showFolder' }),
    openSettings: () => send({ type: 'open:settings' }),
    prepare: (running, opt) => send({ type: 'job:prepare', running, quietUi: !!(opt && opt.quietUi) }),
    lock: (jobId) => send({ type: 'lock:acquire', jobId }),
    unlock: (jobId) => send({ type: 'lock:release', jobId }),
    fetchJson: (url) => send({ type: 'fetch:json', url }),
    onChanged: (fn) => changeListeners.add(fn),
  };

  // --- Источник данных ----------------------------------------------------------
  let source;
  let account;
  let sourceInfo;
  let env = null;
  if (publicLink) {
    source = new YDD.PublicApi({ publicKey: publicLink.publicKey, bgFetch: (url) => bg.fetchJson(url) });
    account = 'pub:' + publicLink.hash;
    sourceInfo = { kind: 'public', publicKey: publicLink.publicKey, origin: location.origin };
  } else {
    env = YDD.PrivateApi.readEnv(document, location);
    source = new YDD.PrivateApi(env);
    account = 'p:' + (env.uid || 'unknown');
    sourceInfo = { kind: 'private', uid: env.uid, login: env.login, origin: location.origin };
  }

  function readSelection() {
    const rows = document.querySelectorAll('.listing-item[aria-selected="true"]');
    const out = [];
    for (const row of rows) {
      const title = row.querySelector('.listing-item__title');
      const name = title && (title.getAttribute('aria-label') || title.textContent || '').trim();
      if (name) out.push({ name, type: /listing-item_type_dir/.test(row.className) ? 'dir' : 'file' });
    }
    return out;
  }

  function pageInfo() {
    if (publicLink) {
      const here = YDD.PublicApi.parseLocation(location) || publicLink;
      const title = (document.title || '').split(/\s+[—–-]\s+Яндекс/)[0].trim();
      return { kind: 'public', path: here.path, title, selection: [], folder: null, browse: { root: '/', start: here.path, title: title || t('label.link') } };
    }
    const folder = YDD.diskPathFromLocation(location.pathname);
    return {
      kind: 'private',
      folder,
      folderName: folder && folder !== '/disk' ? YDD.basename(folder) : null,
      selection: folder ? readSelection() : [],
      unlim: !!(env && env.photounlimAvailable),
      space: env && env.space,
      // Для выбора файлов и папок в панели: откуда начинать и что считать корнем.
      browse: { root: '/disk', start: folder || '/disk', title: t('label.disk') },
    };
  }

  const localFor = (diskPath) =>
    YDD.relativeToDisk(diskPath)
      .split('/')
      .filter(Boolean)
      .map((part) => YDD.sanitizeComponent(part))
      .join('/');

  /** Имя архива: «Отпуск (выбранное) 2026-10-20 14-30». */
  function zipBaseName(title) {
    const d = new Date();
    const two = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}`;
    return YDD.truncateComponent(YDD.sanitizeComponent(title) || t('fs.root'), 90) + ' ' + stamp;
  }

  async function startNew(scopeType, options, extra) {
    if (app.dead) throw new Error(t('err.extReloadedShort'));
    const info = pageInfo();
    // В архиве пути считаются от того, что выбрано: выделенные файлы лежат в корне архива,
    // папка — одной папкой, а не со всей цепочкой родительских папок Диска.
    const zip = !!(options.dest && options.dest.type === 'zip');
    let scope;
    let zipTitle;
    if (scopeType === 'pick') {
      // Отмечено вручную в панели — может быть из разных папок.
      const picked = (extra.picked || []).filter((x) => x && x.id);
      if (!picked.length) throw new Error(t('err.nothingPicked'));
      if (info.kind !== 'public' && !env.sk) throw new Error(t('err.noSession'));
      let rootPath = '/disk';
      let rootName = t('fs.root');
      let prefix = '';
      if (info.kind === 'public') {
        const res = await source.info('/');
        rootPath = '/';
        rootName = res.name || publicLink.hash;
        prefix = YDD.joinPath(YDD.sanitizeComponent(t('fs.public')), YDD.sanitizeComponent(rootName));
      }
      // На компьютере — те же папки, что на Диске; в архиве — пути от общей папки выбранного.
      const base = zip ? YDD.commonDir(picked.map((x) => YDD.dirname(x.id))) : rootPath;
      const localOf = (path) => YDD.joinPath(zip ? '' : prefix, YDD.relativeLocal(path, base));
      const dirs = picked.filter((x) => x.type === 'dir');
      const files = picked.filter((x) => x.type !== 'dir');
      scope = {
        type: 'pick',
        label: t('label.picked', { summary: YDD.pickSummary(dirs.length, files.length) }),
        roots: dirs.map((d) => ({ path: d.id, local: localOf(d.id) })),
        files: files.map((f) => ({ item: f, parentLocal: localOf(YDD.dirname(f.id)) })),
      };
      if (picked.length === 1 && dirs.length === 1) zipTitle = dirs[0].name;
      else zipTitle = t('fs.selected', { name: base === rootPath ? rootName : YDD.basename(base) });
    } else if (info.kind === 'public') {
      const here = YDD.PublicApi.parseLocation(location) || publicLink;
      const res = await source.info(here.path);
      const name = res.name || here.hash;
      const base = YDD.sanitizeComponent(t('fs.public'));
      const dir = res.type === 'dir';
      scope = {
        type: 'public',
        label: t('label.public', { name }),
        roots: [{ path: here.path, local: zip ? (dir ? YDD.sanitizeComponent(name) : '') : dir ? YDD.joinPath(base, YDD.sanitizeComponent(name)) : base }],
      };
      zipTitle = name;
    } else {
      if (!env.sk) throw new Error(t('err.noSession'));
      if (scopeType === 'folder' && info.folder) {
        const local = zip ? YDD.sanitizeComponent(info.folderName) : localFor(info.folder);
        scope = { type: 'folder', label: t('label.folder', { name: info.folderName }), roots: [{ path: info.folder, local }] };
        zipTitle = info.folderName;
      } else if (scopeType === 'selection' && info.selection.length) {
        const names = info.selection.map((x) => x.name);
        scope = {
          type: 'selection',
          label: t('label.selection', { folder: info.folderName || t('label.files'), n: names.length }),
          roots: [{ path: info.folder, local: zip ? '' : localFor(info.folder), filter: names }],
        };
        zipTitle = t('fs.selected', { name: info.folderName || t('label.disk') });
      } else {
        scope = { type: 'all', label: t('label.all'), roots: [{ path: '/disk', local: '' }], unlim: !!extra.unlim };
        zipTitle = t('fs.root');
      }
    }
    if (zip) options = Object.assign({}, options, { dest: Object.assign({}, options.dest, { name: zipBaseName(zipTitle) }) });
    const carry = extra.skipDone ? engine.doneMap() : null;
    if (engine.job) await engine.discard();
    await engine.createJob({ scope, options, carry, filter: extra.typeFilter || null });
    engine.start();
  }

  function downloadReport() {
    if (!engine.job) return;
    const blob = new Blob([engine.buildReport()], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
    a.download = YDD.sanitizeComponent(t('fs.report', { stamp }));
    a.style.display = 'none';
    document.documentElement.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // --- Язык интерфейса ----------------------------------------------------------------
  // Словари читает фоновый скрипт: из страницы сайта файлы расширения недоступны.
  const dictCache = new Map();
  async function loadDict(code) {
    if (!dictCache.has(code)) {
      const res = await send({ type: 'i18n:get', code });
      if (!res || !res.ok) return {};
      dictCache.set(code, res.dict || {});
    }
    return dictCache.get(code);
  }
  async function useLang(code) {
    const lang = YDD.i18n.has(code) ? code : 'ru';
    const [dict, base] = await Promise.all([loadDict(lang), loadDict('ru')]);
    YDD.i18n.use(lang, dict, base);
  }
  try {
    const saved = (await chrome.storage.local.get('ydd:lang'))['ydd:lang'];
    await useLang(saved || YDD.i18n.detect(navigator.languages || [navigator.language]));
  } catch (e) {
    await useLang('ru').catch(() => {});
  }
  // Сначала запоминаем выбор, потом грузим словарь: так выбор не потеряется,
  // даже если страницу перезагрузят, пока фоновый скрипт ещё просыпается.
  let wantedLang = null;
  app.setLang = async (code) => {
    wantedLang = YDD.i18n.has(code) ? code : 'ru';
    await chrome.storage.local.set({ 'ydd:lang': wantedLang }).catch(() => {});
    await useLang(wantedLang);
    if (ui) ui.rerender();
  };

  // --- Сборка -------------------------------------------------------------------
  const store = new YDD.JobStore(chrome.storage.local);
  // Сроки ожидания можно переопределить (используют автотесты); обычно ключа нет.
  let timing;
  try {
    timing = (await chrome.storage.local.get('ydd:timing'))['ydd:timing'] || undefined;
  } catch (e) {
    timing = undefined;
  }
  engine = new YDD.Engine({ source, bg, store, account, sourceInfo, timing });
  Object.assign(app, {
    engine,
    bg,
    pageInfo,
    startNew,
    browse: (path, cursor) => source.listDir(path, cursor),
    downloadReport,
    settings: {},
    saveSettings: async (s) => {
      app.settings = s;
      await store.setSettings(s);
    },
  });
  try {
    app.settings = await store.getSettings();
  } catch (e) {
    app.settings = {};
  }
  // Облако или сервер для переноса: здесь только название, ключи читает offscreen-документ.
  try {
    app.dest = (await chrome.storage.local.get('ydd:dest'))['ydd:dest'] || null;
  } catch (e) {
    app.dest = null;
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // Язык сменили в другой вкладке или на странице настроек.
    const lang = changes['ydd:lang'] && changes['ydd:lang'].newValue;
    if (lang && lang !== YDD.i18n.lang && lang !== wantedLang) {
      wantedLang = lang;
      useLang(lang).then(() => ui && ui.rerender());
    }
    if (!changes['ydd:dest']) return;
    app.dest = changes['ydd:dest'].newValue || null;
    if (ui && ui.isOpen && ui.view === 'setup') ui.showSetup({ afterJob: !!engine.job });
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'dl:changed') changeListeners.forEach((fn) => fn(msg.item));
    else if (msg.type === 'panel:toggle') {
      if (ui) ui.toggle();
      sendResponse({ ok: true });
    } else if (msg.type === 'ping') {
      const job = engine.job;
      sendResponse({ running: !!(job && job.meta.id === msg.jobId && job.meta.phase === 'running') });
    }
  });

  ui = new YDD.Ui(app);
  ui.mount();
  engine.on((snap) => ui.update(snap));

  let resumeRecent = false;
  try {
    const job = await engine.loadCurrent();
    // Страницу перезагрузили или браузер перезапустился во время скачивания — продолжаем сами.
    resumeRecent = !!(job && engine.interrupted && Date.now() - job.meta.updatedAt < 10 * 60 * 1000);
  } catch (e) {
    console.warn('[YDD] не удалось загрузить сохранённое задание', e);
  }
  ui.refreshFab();
  if (resumeRecent) {
    engine.start();
    ui.open();
  } else if (location.hash.includes('ydd-open') || (engine.job && engine.interrupted)) {
    ui.open();
  }

  // Подписи кнопки следуют за выделением и переходами по папкам.
  let selTimer = null;
  const refresh = () => {
    if (selTimer) return;
    selTimer = setTimeout(() => {
      selTimer = null;
      ui.refreshFab();
    }, 300);
  };
  new MutationObserver(refresh).observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-selected'],
  });
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      refresh();
    }
  }, 1000);

  window.addEventListener('pagehide', () => {
    if (engine.job) {
      engine.flush();
      if (engine.job.meta.phase === 'running') bg.prepare(false, engine.job.meta.opt);
    }
  });
})();
