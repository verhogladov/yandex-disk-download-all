/*
 * Offscreen-документ: переносит файлы с Яндекс Диска в облако или на сервер
 * и собирает ZIP-архивы — без сохранения отдельных файлов на диск компьютера.
 * Для движка выглядит так же, как chrome.downloads: у каждого файла есть id,
 * состояние и счётчик байтов.
 */
(function () {
  'use strict';
  const YDD = globalThis.YDD;
  const transfers = new Map();
  let destination = null;
  let destinationKey = '';

  // В offscreen-документе нет chrome.storage — настройки облака присылает фоновый скрипт.
  async function getDestination(cfg) {
    const key = JSON.stringify(cfg || null);
    if (key !== destinationKey) {
      destination = YDD.createDestination(cfg);
      destinationKey = key;
    }
    if (!destination) throw new YDD.DestError('DEST_CONFIG', YDD.t('dest.err.notConfigured'));
    return destination;
  }

  // Переводы: язык присылает вкладка вместе с файлом, словари читаем из файлов расширения.
  const dictionaries = new Map();
  function loadDict(code) {
    if (!dictionaries.has(code)) {
      dictionaries.set(
        code,
        fetch(chrome.runtime.getURL(`locales/${code}.json`))
          .then((res) => res.json())
          .catch(() => ({}))
      );
    }
    return dictionaries.get(code);
  }
  let langCode = null;
  let langReady = Promise.resolve();
  function ensureLang(code) {
    const want = YDD.i18n.has(code) ? code : 'ru';
    if (want !== langCode) {
      langCode = want;
      langReady = Promise.all([loadDict(want), loadDict('ru')]).then(([dict, base]) => YDD.i18n.use(want, dict, base));
    }
    return langReady;
  }

  function snapshot(t) {
    const zip = t.kind === 'zip';
    return {
      id: t.id,
      state: t.state,
      error: t.error,
      message: t.message,
      // Для облака прогресс двойной: скачивание с Яндекса, затем отправка.
      bytesReceived: zip ? t.downloaded : t.downloaded + t.uploaded,
      totalBytes: t.size ? (zip ? t.size : t.size * 2) : 0,
      fileSize: t.state === 'complete' ? t.downloaded : 0,
      filename: t.filename,
      danger: 'safe',
      paused: false,
      // Идёт отправка в облако или сжатие: байты не двигаются, но работа идёт.
      busy: !!t.busy,
      part: t.part || null,
      sealed: t.sealed || null,
    };
  }

  function notify(t) {
    chrome.runtime.sendMessage({ type: 'transfer:changed', item: snapshot(t) }).catch(() => {});
  }

  function sourceError(status) {
    if (status === 404) return 'SERVER_BAD_CONTENT';
    if (status === 401 || status === 403) return 'SERVER_FORBIDDEN';
    return 'SERVER_FAILED';
  }

  /** Запрос файла с Яндекса с cookie пользователя. */
  async function fetchSource(t, signal) {
    const res = await fetch(t.url, {
      credentials: 'include',
      signal,
      headers: t.accept ? { Accept: t.accept } : undefined,
    });
    if (!res.ok) {
      const e = new Error(YDD.t('dest.err.yandexRefused', { status: res.status }));
      e.code = sourceError(res.status);
      throw e;
    }
    const length = Number(res.headers.get('Content-Length')) || 0;
    if (length) t.size = length;
    const reader = res.body.getReader();
    async function* chunks() {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        t.downloaded += value.byteLength;
        yield value;
      }
    }
    return { res, length, chunks };
  }

  async function run(t) {
    const ctrl = (t.ctrl = new AbortController());
    try {
      if (t.kind === 'zip') await toArchive(t, ctrl.signal);
      else await toDestination(t, ctrl.signal);
      if (!t.size) t.size = t.downloaded;
      t.state = 'complete';
    } catch (e) {
      t.state = 'interrupted';
      if (ctrl.signal.aborted) t.error = 'USER_CANCELED';
      else if (e && e.code) t.error = e.code;
      else t.error = 'NETWORK_FAILED';
      t.message = (e && e.message) || String(e);
    } finally {
      t.ctrl = null;
      t.busy = false;
      notify(t);
      // Через 10 минут забываем: движок к тому времени давно получил результат.
      setTimeout(() => transfers.delete(t.id), 10 * 60 * 1000);
    }
  }

  async function toDestination(t, signal) {
    const dest = await getDestination(t.config);
    t.filename = dest.describe() + ' / ' + t.path;
    const { length, chunks } = await fetchSource(t, signal);
    await dest.upload(t.path, { size: length || t.size || null, chunks }, {
      signal,
      onProgress: (n) => {
        t.uploaded = n;
      },
      onBusy: (busy) => {
        t.busy = busy;
      },
    });
    t.uploaded = t.downloaded;
  }

  // --- ZIP-архив ---------------------------------------------------------------------
  // По каждому заданию: открытая часть пополняется файлами; закрытые части ждут, пока
  // движок сохранит их через загрузки браузера. До этого они лежат во временном
  // хранилище браузера (большие — на диске, в папке профиля).
  const archives = new Map();

  function archiveFor(jobId, firstPart) {
    let a = archives.get(jobId);
    if (!a) {
      a = { next: Math.max(1, Number(firstPart) || 1), open: null, sealed: new Map(), placed: new Map() };
      archives.set(jobId, a);
    }
    return a;
  }

  function seal(a, final) {
    const o = a.open;
    a.open = null;
    if (!o || !o.entries.length) return;
    const blob = o.volume.finish();
    a.sealed.set(o.n, { n: o.n, blob, url: URL.createObjectURL(blob), entries: o.entries, bytes: blob.size, final: !!final });
  }

  const sealedList = (a) => [...a.sealed.values()].map((p) => ({ n: p.n, final: p.final, entries: p.entries, bytes: p.bytes }));

  /** Кладёт файл в открытую часть; если часть перерастёт предел — закрывает её. */
  function place(a, entry, idx, partBytes) {
    if (a.placed.has(idx)) return a.placed.get(idx); // файл уже в архиве (повтор после обрыва связи)
    if (a.open && a.open.entries.length && a.open.volume.size + entry.data.size > partBytes) seal(a, false);
    if (!a.open) a.open = { n: a.next++, volume: new YDD.ZipVolume(), entries: [] };
    a.open.volume.add(entry);
    a.open.entries.push(idx);
    a.placed.set(idx, a.open.n);
    const n = a.open.n;
    if (a.open.volume.size >= partBytes) seal(a, false);
    return n;
  }

  async function toArchive(t, signal) {
    t.filename = t.path;
    const { res, chunks } = await fetchSource(t, signal);
    const mtime = t.mtime || Date.parse(res.headers.get('Last-Modified') || '') || Date.now();
    let entry;
    try {
      entry = await YDD.prepareEntry(t.path, chunks(), {
        mtime,
        compress: t.packAll || YDD.shouldCompress(t.path),
        onCompress: (busy) => {
          t.busy = busy;
        },
      });
    } catch (e) {
      if (signal.aborted || e.code) throw e;
      // Сеть оборвалась посреди файла или браузеру не хватило временного места.
      const err = new Error(String((e && e.message) || e));
      err.code = /network|fetch|body|stream/i.test(err.message) ? 'NETWORK_FAILED' : 'ZIP_FAILED';
      throw err;
    }
    if (signal.aborted) throw new Error('aborted');
    const a = archiveFor(t.jobId, t.firstPart);
    t.part = place(a, entry, t.idx, t.partBytes);
    t.sealed = sealedList(a).map((p) => ({ n: p.n, final: p.final }));
  }

  function releasePart(a, n) {
    const p = a.sealed.get(n);
    if (!p) return;
    URL.revokeObjectURL(p.url);
    a.sealed.delete(n);
    for (const idx of p.entries) if (a.placed.get(idx) === n) a.placed.delete(idx);
  }

  function dropArchive(jobId) {
    const a = archives.get(jobId);
    for (const t of transfers.values()) if (t.jobId === jobId && t.ctrl) t.ctrl.abort();
    if (!a) return;
    for (const n of [...a.sealed.keys()]) releasePart(a, n);
    archives.delete(jobId);
  }

  function handleZip(msg) {
    const a = archives.get(msg.jobId);
    switch (msg.type) {
      case 'zip:state':
        if (!a) return { ok: true, exists: false };
        return {
          ok: true,
          exists: true,
          next: a.next,
          open: a.open && a.open.entries.length ? { n: a.open.n, entries: a.open.entries } : null,
          sealed: sealedList(a),
        };
      case 'zip:seal':
        // Всё скачано: закрываем последнюю часть. final — её закрыли не по размеру.
        if (!a) return { ok: true, sealed: [] };
        seal(a, true);
        return { ok: true, sealed: sealedList(a).map((p) => ({ n: p.n, final: p.final })) };
      case 'zip:part': {
        const p = a && a.sealed.get(msg.n);
        if (!p) return { ok: false, error: 'ZIP_LOST' };
        return { ok: true, n: p.n, url: p.url, entries: p.entries, bytes: p.bytes, final: p.final };
      }
      case 'zip:release':
        if (a) releasePart(a, msg.n);
        return { ok: true };
      case 'zip:drop':
        dropArchive(msg.jobId);
        return { ok: true };
      default:
        return null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return;
    if (msg.type === 'transfer:start' || msg.type === 'zip:add') {
      const zip = msg.type === 'zip:add';
      const t = {
        id: msg.id,
        kind: zip ? 'zip' : 'dest',
        url: msg.url,
        path: msg.path,
        accept: msg.accept || null,
        config: msg.config || null,
        size: Number(msg.size) || 0,
        downloaded: 0,
        uploaded: 0,
        state: 'in_progress',
        error: null,
        message: '',
        filename: msg.path,
        ctrl: null,
        // для архива
        jobId: msg.jobId,
        idx: msg.idx,
        mtime: Number(msg.mtime) || 0,
        packAll: !!msg.packAll,
        partBytes: Number(msg.partBytes) || 2 * 1024 * 1024 * 1024,
        firstPart: msg.firstPart,
      };
      transfers.set(t.id, t);
      ensureLang(msg.lang).then(() => run(t));
      sendResponse({ ok: true });
    } else if (msg.type === 'transfer:status') {
      const items = {};
      for (const id of msg.ids || []) if (transfers.has(id)) items[id] = snapshot(transfers.get(id));
      sendResponse({ ok: true, items });
    } else if (msg.type === 'transfer:cancel') {
      const t = transfers.get(msg.id);
      if (t && t.ctrl) t.ctrl.abort();
      sendResponse({ ok: true });
    } else if (msg.type.startsWith('zip:')) {
      sendResponse(handleZip(msg) || { ok: false, error: 'unknown message' });
    }
  });
})();
