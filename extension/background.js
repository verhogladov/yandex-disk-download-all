/*
 * Фоновый скрипт: запускает загрузки через chrome.downloads, сообщает вкладке Диска
 * об их состоянии и следит, чтобы одно задание не шло сразу в двух вкладках.
 */
'use strict';

const WATCH = 'w:'; // id загрузки → вкладка, которой о ней сообщать
const LOCK = 'lock:'; // id задания → вкладка, в которой оно идёт
const session = chrome.storage.session;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg || {}, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

async function handle(msg, sender) {
  const tabId = sender.tab ? sender.tab.id : null;
  switch (msg.type) {
    case 'dl:start':
      if (msg.zip) return startZipAdd(msg, tabId);
      return msg.remote ? startTransfer(msg, tabId) : startDownload(msg, tabId);
    case 'zip:save':
      return saveZipPart(msg, tabId);
    case 'zip:state':
    case 'zip:seal':
    case 'zip:release':
    case 'zip:drop':
      return zipCommand(msg);
    case 'dl:status':
      return status(msg.ids, tabId);
    case 'dl:cancel':
      if (isTransfer(msg.id)) await toOffscreen({ type: 'transfer:cancel', id: msg.id });
      else await chrome.downloads.cancel(msg.id).catch(() => {});
      return { ok: true };
    case 'dl:erase':
      if (!isTransfer(msg.id)) await chrome.downloads.erase({ id: msg.id }).catch(() => {});
      return { ok: true };
    case 'dl:sweep': {
      // Задание закончено: стираем из списка загрузок оставшиеся записи этого расширения,
      // начатые с начала задания. Загрузки, ждущие подтверждения, и ZIP-архивы не трогаем:
      // архив удобно открыть прямо из списка.
      const since = Number(msg.since) || 0;
      const items = await chrome.downloads.search({ startedAfter: new Date(since - 1000).toISOString(), limit: 0 }).catch(() => []);
      for (const it of items) {
        if (it.byExtensionId !== chrome.runtime.id || it.state === 'in_progress' || /\.zip$/i.test(it.filename || '')) continue;
        await chrome.downloads.erase({ id: it.id }).catch(() => {});
      }
      return { ok: true };
    }
    case 'dl:showFolder':
      chrome.downloads.showDefaultFolder();
      return { ok: true };
    case 'open:settings':
      await chrome.tabs.create({ url: 'chrome://settings/downloads' });
      return { ok: true };
    case 'open:options':
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    case 'transfer:changed':
      return forwardTransfer(msg.item);
    case 'job:prepare':
      return prepare(msg, tabId);
    case 'lock:acquire':
      return acquireLock(msg.jobId, tabId);
    case 'lock:release':
      return releaseLock(msg.jobId, tabId);
    case 'fetch:json':
      return fetchJson(msg.url);
    case 'i18n:get':
      return getDictionary(msg.code);
    default:
      return { ok: false, error: 'unknown message' };
  }
}

// «Зависшие» запуски: download() ещё не ответил, отменить его нельзя (id нет), а соединение
// с сервером занято. Браузер держит не больше 6 соединений на сервер — несколько таких файлов
// подряд остановили бы все загрузки. Поэтому, как только появился первый, проверяем каждую
// ссылку коротким запросом fetch (его можно прервать) и только потом отдаём её в загрузки.
let pendingStarts = 0;
let lastHungStart = 0;
const PROBE_WINDOW_MS = 15 * 60 * 1000;

async function probe(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const h = { Range: 'bytes=0-0' };
    for (const x of headers || []) h[x.name] = x.value;
    const res = await fetch(url, { headers: h, credentials: 'include', signal: ctrl.signal, cache: 'no-store' });
    if (res.body) res.body.cancel().catch(() => {});
    if (res.ok || res.status === 416) return { ok: true };
    if (res.status === 404) return { ok: false, error: 'SERVER_BAD_CONTENT' };
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'SERVER_FORBIDDEN' };
    return { ok: false, error: 'SERVER_FAILED' };
  } catch (e) {
    return { ok: false, error: ctrl.signal.aborted ? 'NO_RESPONSE' : 'NETWORK_FAILED' };
  } finally {
    clearTimeout(timer);
  }
}

async function canProbe(url) {
  try {
    const u = new URL(url);
    return await chrome.permissions.contains({ origins: [`https://${u.hostname}/*`] });
  } catch (e) {
    return false;
  }
}

async function startDownload(msg, tabId) {
  if (typeof msg.url !== 'string' || !/^https:\/\//.test(msg.url)) return { ok: false, error: 'bad url' };
  const options = { url: msg.url, filename: msg.filename, conflictAction: 'overwrite', saveAs: false };
  if (Array.isArray(msg.headers) && msg.headers.length) options.headers = msg.headers;
  const timeoutMs = Math.max(5000, Number(msg.timeoutMs) || 60000);
  if ((pendingStarts > 0 || Date.now() - lastHungStart < PROBE_WINDOW_MS) && (await canProbe(msg.url))) {
    const check = await probe(msg.url, options.headers, timeoutMs);
    if (!check.ok) return { ok: false, error: check.error };
  }
  // download() отвечает только когда сервер прислал заголовки. Если узел хранения Яндекса
  // молчит, ждать можно минутами — поэтому ограничиваем ожидание сами.
  const started = chrome.downloads.download(options).then(
    (id) => ({ id }),
    (e) => ({ error: String((e && e.message) || e) })
  );
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
  });
  const result = await Promise.race([started, timeout]);
  clearTimeout(timer);
  if (result.timeout) {
    pendingStarts++;
    lastHungStart = Date.now();
    // Если сервер всё-таки ответит позже — эта загрузка уже никому не нужна. Она могла и успеть
    // завершиться: тогда отмена не сработает, но запись из списка загрузок всё равно стираем.
    // Сам файл не трогаем: путь тот же, что у повторной попытки, и содержимое то же.
    started.then(({ id }) => {
      pendingStarts--;
      if (typeof id === 'number') {
        chrome.downloads
          .cancel(id)
          .catch(() => {})
          .then(() => chrome.downloads.erase({ id }))
          .catch(() => {});
      }
    });
    return { ok: false, error: 'NO_RESPONSE' };
  }
  if (result.error) return { ok: false, error: result.error };
  if (typeof result.id !== 'number') return { ok: false, error: 'download not started' };
  if (tabId != null) await session.set({ [WATCH + result.id]: tabId });
  return { ok: true, id: result.id };
}

function compact(item) {
  return {
    id: item.id,
    state: item.state,
    error: item.error || null,
    danger: item.danger,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    fileSize: item.fileSize,
    filename: item.filename,
    paused: item.paused,
    canResume: item.canResume,
  };
}

async function status(ids, tabId) {
  const items = {};
  const remote = (ids || []).filter(isTransfer);
  await Promise.all(
    (ids || [])
      .filter((id) => !isTransfer(id))
      .map(async (id) => {
        const [item] = await chrome.downloads.search({ id });
        if (!item) return;
        items[id] = compact(item);
        // Вкладку могли перезагрузить — события о загрузке теперь нужны новой.
        if (tabId != null && item.state === 'in_progress') await session.set({ [WATCH + id]: tabId });
      })
  );
  if (remote.length) {
    const res = await toOffscreen({ type: 'transfer:status', ids: remote });
    if (res && res.items) {
      for (const [id, item] of Object.entries(res.items)) {
        items[id] = item;
        if (tabId != null && item.state === 'in_progress') await session.set({ [WATCH + id]: tabId });
      }
    }
  }
  return { ok: true, items };
}

// --- Перенос в облако или на сервер (offscreen-документ) ---------------------------
const isTransfer = (id) => typeof id === 'string' && id.startsWith('t');
let transferSeq = 0;
let creatingOffscreen = null;

/** true/false, или null, если браузер не умеет это проверять (Chrome до 116). */
async function hasOffscreen() {
  if (!chrome.runtime.getContexts) return null;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if ((await hasOffscreen()) === true) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Перенос файлов с Яндекс Диска в облако или на сервер и сборка ZIP-архива без сохранения отдельных файлов на диск',
      })
      .catch((e) => {
        if (!/single offscreen/i.test(String(e && e.message))) throw e;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function toOffscreen(message) {
  if ((await hasOffscreen()) === false) return { ok: false, items: {} };
  try {
    return await chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, message));
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), items: {} };
  }
}

async function startTransfer(msg, tabId) {
  if (typeof msg.url !== 'string' || !/^https:\/\//.test(msg.url)) return { ok: false, error: 'bad url' };
  const config = (await chrome.storage.local.get('ydd:dest:config'))['ydd:dest:config'];
  if (!config || config.type === 'local') return { ok: false, error: 'DEST_CONFIG' };
  await ensureOffscreen();
  const id = 't' + Date.now().toString(36) + '-' + ++transferSeq;
  const accept = Array.isArray(msg.headers) ? (msg.headers.find((h) => /^accept$/i.test(h.name)) || {}).value : null;
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'transfer:start',
    id,
    url: msg.url,
    path: msg.filename,
    size: msg.size || 0,
    accept: accept || null,
    config,
    lang: msg.lang || 'ru',
  });
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'offscreen not ready' };
  if (tabId != null) await session.set({ [WATCH + id]: tabId });
  return { ok: true, id };
}

// --- ZIP-архив: файлы собираются в offscreen-документе, готовые части сохраняются загрузкой ---
async function startZipAdd(msg, tabId) {
  if (typeof msg.url !== 'string' || !/^https:\/\//.test(msg.url)) return { ok: false, error: 'bad url' };
  await ensureOffscreen();
  const id = 't' + Date.now().toString(36) + '-' + ++transferSeq;
  const accept = Array.isArray(msg.headers) ? (msg.headers.find((h) => /^accept$/i.test(h.name)) || {}).value : null;
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'zip:add',
    id,
    url: msg.url,
    path: msg.path,
    size: msg.size || 0,
    accept: accept || null,
    jobId: msg.jobId,
    idx: msg.idx,
    mtime: msg.mtime || 0,
    packAll: !!msg.packAll,
    partBytes: msg.partBytes,
    firstPart: msg.firstPart,
    lang: msg.lang || 'ru',
  });
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'offscreen not ready' };
  if (tabId != null) await session.set({ [WATCH + id]: tabId });
  return { ok: true, id };
}

async function zipCommand(msg) {
  // Offscreen-документа нет — значит, и несохранённых частей архива нет (браузер перезапускали).
  if ((await hasOffscreen()) === false) return { ok: true, exists: false, sealed: [] };
  const res = await toOffscreen({ type: msg.type, jobId: msg.jobId, n: msg.n });
  if (res && res.ok === false && /Receiving end does not exist/i.test(res.error || '')) return { ok: true, exists: false, sealed: [] };
  return res || { ok: false, error: 'no-response' };
}

async function saveZipPart(msg, tabId) {
  const part = await toOffscreen({ type: 'zip:part', jobId: msg.jobId, n: msg.n });
  if (!part || !part.ok) return { ok: false, error: 'ZIP_LOST' };
  let id;
  try {
    id = await chrome.downloads.download({ url: part.url, filename: msg.filename, conflictAction: 'overwrite', saveAs: false });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (tabId != null) await session.set({ [WATCH + id]: tabId });
  return { ok: true, id, entries: part.entries, bytes: part.bytes, final: part.final };
}

async function forwardTransfer(item) {
  if (!item || !item.id) return { ok: false };
  const key = WATCH + item.id;
  const tabId = (await session.get(key))[key];
  if (tabId == null) return { ok: true };
  if (item.state !== 'in_progress') await session.remove(key);
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'dl:changed', item });
  } catch (e) {
    /* вкладку закрыли — результат подберёт следующий запуск */
  }
  return { ok: true };
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!(delta.state || delta.danger || delta.error || delta.filename || delta.paused)) return;
  const key = WATCH + delta.id;
  const tabId = (await session.get(key))[key];
  if (tabId == null) return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item) return;
  if (item.state !== 'in_progress') await session.remove(key);
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'dl:changed', item: compact(item) });
  } catch (e) {
    /* вкладку закрыли — состояние подберёт следующий запуск */
  }
});

async function prepare({ running, quietUi }, tabId) {
  if (tabId != null) {
    // Не даём браузеру выгрузить из памяти вкладку, которая качает.
    await chrome.tabs.update(tabId, { autoDiscardable: !running }).catch(() => {});
  }
  await setDownloadUi(!(running && quietUi));
  return { ok: true };
}

async function setDownloadUi(enabled) {
  if (!chrome.downloads.setUiOptions) return;
  try {
    await chrome.downloads.setUiOptions({ enabled });
  } catch (e) {
    /* браузер не поддерживает — не страшно */
  }
}

async function acquireLock(jobId, tabId) {
  const key = LOCK + jobId;
  const owner = (await session.get(key))[key];
  if (owner != null && owner !== tabId) {
    try {
      const res = await chrome.tabs.sendMessage(owner, { type: 'ping', jobId });
      if (res && res.running) return { ok: false, owner };
    } catch (e) {
      /* прежней вкладки уже нет */
    }
  }
  await session.set({ [key]: tabId });
  return { ok: true };
}

async function releaseLock(jobId, tabId) {
  const key = LOCK + jobId;
  const owner = (await session.get(key))[key];
  if (owner === tabId) await session.remove(key);
  return { ok: true };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const all = await session.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith(LOCK) && all[k] === tabId);
  if (!stale.length) return;
  await session.remove(stale);
  await setDownloadUi(true);
});

// Словари переводов для вкладок Диска: из страницы сайта файлы расширения недоступны.
const LANG_CODE = /^[a-z]{2,3}$/;
const dictionaries = new Map();
async function getDictionary(code) {
  if (!LANG_CODE.test(String(code))) return { ok: false, error: 'bad language' };
  if (!dictionaries.has(code)) {
    dictionaries.set(
      code,
      fetch(chrome.runtime.getURL(`locales/${code}.json`))
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)
    );
  }
  const dict = await dictionaries.get(code);
  return dict ? { ok: true, dict } : { ok: false, error: 'no dictionary' };
}

async function fetchJson(url) {
  if (typeof url !== 'string' || !url.startsWith('https://cloud-api.yandex.net/')) return { ok: false, error: 'forbidden url' };
  try {
    const res = await fetch(url, { credentials: 'omit' });
    const data = await res.json().catch(() => null);
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, networkError: true, error: String((e && e.message) || e) };
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'panel:toggle' });
    if (res && res.ok) return;
  } catch (e) {
    /* на этой вкладке нет Диска */
  }
  await chrome.tabs.create({ url: 'https://disk.yandex.ru/client/disk#ydd-open' });
});

// Если браузер закрыли посреди скачивания, всплывающее окно загрузок могло остаться выключенным.
chrome.runtime.onStartup.addListener(() => setDownloadUi(true));
chrome.runtime.onInstalled.addListener(() => setDownloadUi(true));
