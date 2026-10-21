'use strict';
// Модульные тесты: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const http = require('node:http');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const SRC = path.join(__dirname, '..', 'extension', 'src');
const { readZip } = require('./zip-reader');
for (const f of ['util.js', 'i18n.js', 'private-api.js', 'public-api.js', 'storage.js', 'engine.js', 'destinations.js', 'zip.js']) require(path.join(SRC, f));
const YDD = globalThis.YDD;
const RU = require(path.join(SRC, '..', 'locales', 'ru.json'));
YDD.i18n.use('ru', RU, RU);
const { ST } = YDD;

// --- Вспомогательное -----------------------------------------------------------
function memoryArea() {
  const data = new Map();
  return {
    data,
    async get(keys) {
      const list = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) data.delete(k);
    },
  };
}

/** Дерево Диска в памяти: {'/disk': [{name, type, size, mediaType}], ...}. */
function fakeSource(tree, behavior = {}) {
  const calls = { list: 0, link: 0, info: 0 };
  const sizeOf = new Map();
  for (const [dir, items] of Object.entries(tree)) for (const it of items) sizeOf.set(dir + '/' + it.name, it.size ?? 10);
  return {
    calls,
    onRateLimit: null,
    async listDir(p, cursor) {
      calls.list++;
      if (behavior.listDelayMs) await new Promise((r) => setTimeout(r, behavior.listDelayMs));
      if (behavior.listFail && behavior.listFail(p)) throw new YDD.ApiError('нет связи', { kind: 'server', retryable: true });
      const items = tree[p];
      if (!items) throw new YDD.ApiError('нет папки', { kind: 'notfound' });
      const off = (cursor && cursor.offset) || 0;
      const page = items.slice(off, off + 40).map((it) => ({
        id: p + '/' + it.name,
        name: it.name,
        type: it.type || 'file',
        size: it.type === 'dir' ? null : it.size ?? 10,
        mediaType: it.mediaType || null,
        sizes: null,
        partial: !!it.partial,
      }));
      return { items: page, next: off + 40 < items.length ? { offset: off + page.length } : null };
    },
    async getFileUrl(p) {
      calls.link++;
      const b = behavior.link && behavior.link(p);
      if (b === 'notfound') throw new YDD.ApiError('нет файла', { kind: 'notfound' });
      if (b === 'auth') throw new YDD.ApiError('войдите', { kind: 'auth' });
      return `https://downloader.disk.yandex.ru/disk/x?path=${encodeURIComponent(p)}&size=${sizeOf.get(p) ?? 10}`;
    },
    async info(p) {
      calls.info++;
      return {
        id: p,
        name: YDD.basename(p),
        type: 'file',
        size: sizeOf.get(p) ?? 10,
        mediaType: 'image',
        sizes: [
          { name: 'ORIGINAL', url: `https://downloader.disk.yandex.ru/disk/orig?path=${encodeURIComponent(p)}&size=${sizeOf.get(p)}` },
          { name: 'XXXL', url: `https://3.downloader.disk.yandex.ru/preview/p?path=${encodeURIComponent(p)}&size=777` },
          { name: 'S', url: 'https://3.downloader.disk.yandex.ru/preview/small' },
        ],
      };
    },
    async photosliceInit() {
      return behavior.photoslice.id;
    },
    async photosliceClusters() {
      return behavior.photoslice.clusters;
    },
    async photosliceResources(psid, request) {
      return behavior.photoslice.resources(request);
    },
  };
}

/**
 * Имитация chrome.downloads. plan(url, filename, n) → 'ok' | 'stall' | 'interrupt:CODE' | 'danger' | 'invalid'.
 */
function fakeBg(plan = () => 'ok') {
  let nextId = 1;
  const items = new Map();
  const listeners = new Set();
  const started = [];
  const notify = (item) => listeners.forEach((fn) => fn(Object.assign({}, item)));

  // Архив, как его ведёт offscreen-документ: открытая часть и закрытые, ждущие сохранения.
  const archives = new Map();
  const savedParts = [];
  const archiveFor = (jobId, firstPart) => {
    if (!archives.has(jobId)) archives.set(jobId, { next: firstPart || 1, open: null, sealed: new Map(), placed: new Map() });
    return archives.get(jobId);
  };
  const seal = (a, final) => {
    const o = a.open;
    a.open = null;
    if (o && o.entries.length) a.sealed.set(o.n, { n: o.n, entries: o.entries, bytes: o.size, final });
  };
  const place = (a, entry, partBytes) => {
    if (a.placed.has(entry.idx)) return a.placed.get(entry.idx);
    if (a.open && a.open.entries.length && a.open.size + entry.bytes > partBytes) seal(a, false);
    if (!a.open) a.open = { n: a.next++, entries: [], size: 0 };
    a.open.entries.push(entry);
    a.open.size += entry.bytes;
    a.placed.set(entry.idx, a.open.n);
    const n = a.open.n;
    if (a.open.size >= partBytes) seal(a, false);
    return n;
  };
  const sealedList = (a) => [...a.sealed.values()].map((p) => ({ n: p.n, final: p.final }));

  return {
    started,
    items,
    archives,
    savedParts,
    zipSavePlan: () => 'ok',
    zipAddDelay: 3,
    zipStateDelay: 0,
    locks: 0,
    sweeps: [],
    async sweep(since) {
      this.sweeps.push(since);
      return { ok: true };
    },
    async startZip({ jobId, idx, url, path: file, size, partBytes, firstPart }) {
      const p = plan(url, file, started.length);
      const id = 't' + nextId++;
      const bytes = Number(new URL(url).searchParams.get('size')) || size || 0;
      const item = { id, state: 'in_progress', bytesReceived: 0, totalBytes: bytes, fileSize: 0, filename: file, danger: 'safe' };
      items.set(id, item);
      started.push({ id, url, filename: file, plan: p, zip: true });
      setTimeout(() => {
        if (item.state !== 'in_progress') return;
        if (p === 'ok') {
          const a = archiveFor(jobId, firstPart);
          const n = place(a, { idx, path: file, bytes }, partBytes);
          Object.assign(item, { state: 'complete', bytesReceived: bytes, fileSize: bytes, part: n, sealed: sealedList(a) });
        } else if (p.startsWith('interrupt:')) Object.assign(item, { state: 'interrupted', error: p.slice(10), message: 'сбой' });
        notify(item);
      }, this.zipAddDelay);
      return { ok: true, id };
    },
    async zipSave({ jobId, n, filename }) {
      const a = archives.get(jobId);
      const part = a && a.sealed.get(n);
      if (!part) return { ok: false, error: 'ZIP_LOST' };
      const p = this.zipSavePlan(n, filename);
      const id = nextId++;
      const item = { id, state: 'in_progress', bytesReceived: 0, totalBytes: part.bytes, fileSize: 0, filename: '', danger: 'safe' };
      items.set(id, item);
      setTimeout(() => {
        item.filename = '/Downloads/' + filename;
        if (p === 'ok') {
          Object.assign(item, { state: 'complete', bytesReceived: part.bytes, fileSize: part.bytes });
          savedParts.push({ n, filename, bytes: part.bytes, paths: part.entries.map((e) => e.path) });
        } else if (p.startsWith('interrupt:')) Object.assign(item, { state: 'interrupted', error: p.slice(10) });
        notify(item);
      }, 3);
      return { ok: true, id, entries: part.entries.map((e) => e.idx), bytes: part.bytes, final: part.final };
    },
    async zipState(jobId) {
      // Как у настоящего offscreen-документа: состояние снимается сразу, ответ приходит позже.
      const a = archives.get(jobId);
      const state = !a
        ? { ok: true, exists: false }
        : {
            ok: true,
            exists: true,
            next: a.next,
            open: a.open && a.open.entries.length ? { n: a.open.n, entries: a.open.entries.map((e) => e.idx) } : null,
            sealed: [...a.sealed.values()].map((p) => ({ n: p.n, final: p.final, bytes: p.bytes, entries: p.entries.map((e) => e.idx) })),
          };
      if (this.zipStateDelay) await new Promise((r) => setTimeout(r, this.zipStateDelay));
      return state;
    },
    async zipSeal(jobId) {
      const a = archives.get(jobId);
      if (!a) return { ok: true, sealed: [] };
      seal(a, true);
      return { ok: true, sealed: sealedList(a) };
    },
    async zipRelease(jobId, n) {
      const a = archives.get(jobId);
      const p = a && a.sealed.get(n);
      if (p) {
        p.entries.forEach((e) => a.placed.delete(e.idx));
        a.sealed.delete(n);
      }
      return { ok: true };
    },
    async zipDrop(jobId) {
      archives.delete(jobId);
      return { ok: true };
    },
    /** Браузер перезапустили: несохранённые части и незаконченные файлы пропали. */
    restartBrowser() {
      archives.clear();
      for (const [id, it] of items) if (typeof id === 'string' && it.state === 'in_progress') items.delete(id);
    },
    async startDownload({ url, filename }) {
      const p = plan(url, filename, started.length);
      if (p === 'invalid') return { ok: false, error: 'Invalid filename' };
      if (p === 'noresponse') {
        started.push({ id: null, url, filename, plan: p });
        return { ok: false, error: 'NO_RESPONSE' };
      }
      if (p.startsWith('startfail:')) {
        started.push({ id: null, url, filename, plan: p });
        return { ok: false, error: p.slice(10) };
      }
      const id = nextId++;
      const size = Number(new URL(url).searchParams.get('size')) || 0;
      const item = { id, state: 'in_progress', bytesReceived: 0, totalBytes: 0, fileSize: 0, filename: '', danger: 'safe' };
      items.set(id, item);
      started.push({ id, url, filename, plan: p });
      setTimeout(() => {
        item.filename = '/Downloads/' + filename;
        if (p === 'ok') Object.assign(item, { state: 'complete', bytesReceived: size, totalBytes: size, fileSize: size });
        else if (p.startsWith('finishing:')) {
          // Данные получены, но браузер ещё «проверяет» файл.
          Object.assign(item, { bytesReceived: size, totalBytes: size, fileSize: size });
          setTimeout(() => {
            item.state = 'complete';
            notify(item);
          }, Number(p.slice(10)));
        } else if (p.startsWith('interrupt:')) Object.assign(item, { state: 'interrupted', error: p.slice(10) });
        else if (p === 'danger') item.danger = 'file';
        notify(item);
      }, 3);
      return { ok: true, id };
    },
    // Перенос в облако: те же планы, но id строковые, как у offscreen-документа.
    async startTransfer({ url, filename, size }) {
      const p = plan(url, filename, started.length);
      const id = 't' + nextId++;
      const bytes = Number(new URL(url).searchParams.get('size')) || size || 0;
      const item = { id, state: 'in_progress', bytesReceived: 0, totalBytes: bytes * 2, fileSize: 0, filename, danger: 'safe' };
      items.set(id, item);
      started.push({ id, url, filename, plan: p, remote: true });
      setTimeout(() => {
        if (p === 'ok') Object.assign(item, { state: 'complete', bytesReceived: bytes * 2, fileSize: bytes });
        else if (p.startsWith('interrupt:')) Object.assign(item, { state: 'interrupted', error: p.slice(10), message: 'ответ сервера' });
        notify(item);
      }, 3);
      return { ok: true, id };
    },
    async status(ids) {
      const out = {};
      for (const id of ids) if (items.has(id)) out[id] = Object.assign({}, items.get(id));
      return { ok: true, items: out };
    },
    async openOptions() {},
    async cancel(id) {
      const it = items.get(id);
      if (it && it.state === 'in_progress') Object.assign(it, { state: 'interrupted', error: 'USER_CANCELED' });
      return { ok: true };
    },
    async erase(id) {
      items.delete(id);
      return { ok: true };
    },
    async showFolder() {},
    async openSettings() {},
    async prepare() {},
    async lock() {
      this.locks++;
      return { ok: true };
    },
    async unlock() {
      return { ok: true };
    },
    async fetchJson() {
      return { ok: false };
    },
    onChanged(fn) {
      listeners.add(fn);
    },
  };
}

const FAST = { firstByteMs: 250, stallMs: 250, retryDelayMs: 30, pollMs: 40, flushMs: 10, slowFactor: 1 };

function makeEngine({ source, bg, area }) {
  const store = new YDD.JobStore(area || memoryArea());
  return new YDD.Engine({ source, bg, store, account: 'p:1', sourceInfo: { kind: 'private', uid: '1' }, timing: FAST });
}

const ALL = { type: 'all', label: 'Весь Диск', roots: [{ path: '/disk', local: '' }] };

function statusByName(engine) {
  const out = {};
  engine.job.files.forEach((f, i) => (out[f[0]] = engine.job.st[i]));
  return out;
}

// --- Имена файлов ----------------------------------------------------------------
test('sanitizeComponent повторяет правила chrome.downloads', () => {
  const s = YDD.sanitizeComponent;
  assert.equal(s('Фото 2019.jpg'), 'Фото 2019.jpg');
  assert.equal(s('a:b*c?d"e<f>g|h\\i/j.txt'), 'a_b_c_d_e_f_g_h_i_j.txt');
  assert.equal(s('.nomedia'), '_nomedia');
  assert.equal(s('..hidden'), '__hidden');
  assert.equal(s('name.'), 'name_');
  assert.equal(s('  пробелы  '), '__пробелы__');
  assert.equal(s('~$Отчёт.docx'), '_$Отчёт.docx');
  assert.equal(s('копия~1.txt'), 'копия_1.txt');
  assert.equal(s('CON'), '_CON');
  assert.equal(s('con.txt'), '_con.txt');
  assert.equal(s('lpt1'), '_lpt1');
  assert.equal(s('Desktop.ini'), '_Desktop.ini');
  assert.equal(s('ярлык.lnk'), 'ярлык.lnk_');
  assert.equal(s('evil‮gpj.exe'), 'evil_gpj.exe');
  assert.equal(s('zero​width'), 'zero_width');
  assert.equal(s('tab\there'), 'tab_here');
  assert.equal(s(''), '_');
  assert.equal(s('й'.normalize('NFD')), 'й'.normalize('NFC'));
  const long = s('Очень'.repeat(60) + '.jpeg');
  assert.ok(Buffer.byteLength(long) <= 180, 'длина в байтах ' + Buffer.byteLength(long));
  assert.ok(long.endsWith('.jpeg'));
  assert.equal(s('a', { strict: true }), 'a');
  assert.equal(s('emoji😀.png', { strict: true }), 'emoji_.png');
});

test('PathAllocator разводит имена без учёта регистра', () => {
  const a = new YDD.PathAllocator();
  assert.equal(a.alloc('Фото', 'Photo.JPG', '/disk/Фото/Photo.JPG'), 'Фото/Photo.JPG');
  assert.equal(a.alloc('Фото', 'photo.jpg', '/disk/Фото/photo.jpg'), 'Фото/photo (2).jpg');
  assert.equal(a.alloc('Фото', 'PHOTO.jpg', '/disk/Фото/PHOTO.jpg'), 'Фото/PHOTO (3).jpg');
  assert.equal(a.alloc('Фото', 'Photo.JPG', '/disk/Фото/Photo.JPG'), 'Фото/Photo.JPG', 'тот же владелец получает тот же путь');
  assert.equal(a.alloc('', 'a:b', '/disk/a:b'), 'a_b');
  assert.equal(a.alloc('', 'a?b', '/disk/a?b'), 'a_b (2)', 'после очистки имена совпали');
  const b = new YDD.PathAllocator();
  b.restore('Фото/Photo.JPG', '/disk/Фото/Photo.JPG');
  assert.equal(b.alloc('Фото', 'photo.jpg', '/disk/Фото/photo.jpg'), 'Фото/photo (2).jpg');
  assert.equal(b.alloc('', 'фото', 'dir:/disk/фото'), 'фото (2)', 'папка «Фото» уже занята восстановленным путём');
});

test('fitPath укорачивает слишком длинные пути', () => {
  const deep = Array.from({ length: 20 }, (_, i) => 'Папка номер ' + i).join('/') + '/файл.jpg';
  assert.ok(deep.length > 230);
  const full = YDD.fitPath('Яндекс Диск', deep);
  assert.ok(full.length <= 230);
  assert.ok(full.startsWith('Яндекс Диск/_Слишком длинные пути/'));
  assert.ok(full.endsWith('_файл.jpg'));
  assert.equal(YDD.fitPath('Яндекс Диск', 'a/b.txt'), 'Яндекс Диск/a/b.txt');
});

test('пути Диска и ссылки', () => {
  assert.equal(YDD.diskPathFromLocation('/client/disk'), '/disk');
  assert.equal(YDD.diskPathFromLocation('/client/disk/'), '/disk');
  assert.equal(YDD.diskPathFromLocation('/client/disk/%D0%A4%D0%BE%D1%82%D0%BE/2019'), '/disk/Фото/2019');
  assert.equal(YDD.diskPathFromLocation('/client/disk/100%'), '/disk/100%');
  assert.equal(YDD.diskPathFromLocation('/client/recent'), null);
  assert.equal(YDD.relativeToDisk('/disk/Фото/a.jpg'), 'Фото/a.jpg');
  assert.equal(YDD.absoluteUrl('//downloader.disk.yandex.ru/x?a=1&amp;b=2'), 'https://downloader.disk.yandex.ru/x?a=1&b=2');
  assert.ok(YDD.isYandexUrl('https://s123klg.storage.yandex.net/file'));
  assert.ok(YDD.isYandexUrl('https://downloader.disk.yandex.ru/disk/abc'));
  assert.ok(!YDD.isYandexUrl('https://evil.example/yandex.ru'));
  assert.ok(!YDD.isYandexUrl('http://downloader.disk.yandex.ru/disk/abc'));
  const sizes = [
    { name: 'S', url: '//d/s' },
    { name: 'XXXL', url: '//d/xxxl' },
    { name: 'ORIGINAL', url: 'https://downloader.disk.yandex.ru/disk/abc/def' },
  ];
  assert.deepEqual(YDD.pickPreview(sizes), { name: 'XXXL', url: 'https://d/xxxl' });
  assert.equal(YDD.originalFromSizes(sizes), 'https://downloader.disk.yandex.ru/disk/abc/def');
  assert.equal(YDD.originalFromSizes([{ name: 'ORIGINAL', url: 'https://downloader.disk.yandex.ru/preview/abc' }]), null);
  assert.equal(YDD.previewName('Фото/IMG_1.HEIC'), 'Фото/IMG_1 (превью).jpg');
  const pub = YDD.PublicApi.parseLocation({ origin: 'https://disk.yandex.ru', pathname: '/d/AbC123/%D0%9F%D0%B0%D0%BF%D0%BA%D0%B0' });
  assert.deepEqual(pub, { publicKey: 'https://disk.yandex.ru/d/AbC123', path: '/Папка', hash: 'AbC123' });
});

test('форматирование по-русски', () => {
  assert.equal(YDD.plural(1, 'файл', 'файла', 'файлов'), 'файл');
  assert.equal(YDD.plural(3, 'файл', 'файла', 'файлов'), 'файла');
  assert.equal(YDD.plural(11, 'файл', 'файла', 'файлов'), 'файлов');
  assert.equal(YDD.plural(21, 'файл', 'файла', 'файлов'), 'файл');
  assert.equal(YDD.plural(112, 'файл', 'файла', 'файлов'), 'файлов');
  assert.equal(YDD.formatBytes(0), '0 Б');
  assert.equal(YDD.formatBytes(1536), '1,5 КБ');
  assert.equal(YDD.formatBytes(5 * 1024 ** 3), '5 ГБ');
  assert.equal(YDD.formatDuration(30), 'меньше минуты');
  assert.equal(YDD.formatDuration(4800), '1 ч 20 мин');
});

test('коды прерывания загрузки', () => {
  assert.equal(YDD.interruptResult('FILE_NO_SPACE').kind, 'nospace');
  assert.equal(YDD.interruptResult('SERVER_FAILED').kind, 'server');
  assert.equal(YDD.interruptResult('NETWORK_TIMEOUT').kind, 'network');
  assert.equal(YDD.interruptResult('USER_CANCELED').kind, 'canceled');
  assert.equal(YDD.interruptResult('FILE_ACCESS_DENIED').kind, 'local');
  assert.equal(YDD.interruptResult('FILE_NAME_TOO_LONG').kind, 'toolong');
});

// --- Движок ----------------------------------------------------------------------
test('скачивает всё дерево: вложенные папки, порции по 40, странные имена', async () => {
  const many = Array.from({ length: 95 }, (_, i) => ({ name: `IMG_${String(i).padStart(3, '0')}.jpg`, size: 1000 + i, mediaType: 'image' }));
  const tree = {
    '/disk': [
      { name: 'Фото', type: 'dir' },
      { name: 'фото', type: 'dir' },
      { name: 'Документы', type: 'dir' },
      { name: 'readme.txt', size: 5 },
      { name: 'CON.txt', size: 6 },
      { name: '.nomedia', size: 0 },
      { name: 'part.mov', size: 100, partial: true },
    ],
    '/disk/Фото': many,
    '/disk/фото': [{ name: 'x.jpg', size: 7 }],
    '/disk/Документы': [
      { name: 'Пустая', type: 'dir' },
      { name: 'отчёт: итог?.docx', size: 8 },
      { name: 'Отчёт.docx', size: 9 },
      { name: 'отчёт.DOCX', size: 10 },
    ],
    '/disk/Документы/Пустая': [],
  };
  const source = fakeSource(tree);
  const bg = fakeBg();
  const engine = makeEngine({ source, bg });
  await engine.createJob({ scope: ALL, options: { concurrency: 3 } });
  await engine.start();
  const s = engine.snapshot();
  assert.equal(s.job.phase, 'done');
  assert.equal(s.total, 95 + 1 + 3 + 3 + 1);
  assert.equal(s.done, s.total - 1);
  assert.equal(s.skipped, 1, 'недозагруженный в облако файл пропущен');
  assert.equal(s.failed, 0);
  assert.equal(bg.started.length, s.total - 1);
  const names = bg.started.map((d) => d.filename).sort();
  assert.ok(names.includes('Яндекс Диск/readme.txt'));
  assert.ok(names.includes('Яндекс Диск/_CON.txt'));
  assert.ok(names.includes('Яндекс Диск/_nomedia'));
  assert.ok(names.includes('Яндекс Диск/Фото/IMG_094.jpg'));
  assert.ok(names.includes('Яндекс Диск/фото (2)/x.jpg'), 'папки «Фото» и «фото» не слились');
  assert.ok(names.includes('Яндекс Диск/Документы/отчёт_ итог_.docx'));
  assert.ok(names.includes('Яндекс Диск/Документы/Отчёт.docx'));
  assert.ok(names.includes('Яндекс Диск/Документы/отчёт (2).DOCX'));
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, 'все пути уникальны');
  assert.equal(source.calls.list, 1 + 3 + 1 + 1 + 1, 'папка из 95 файлов прочитана за 3 запроса');
  assert.equal(s.bytesDone, s.totalBytes - 100);
  assert.deepEqual(bg.sweeps, [s.job.createdAt], 'в конце список загрузок подчищается один раз, с начала задания');
  // Порядок: файлы скачиваются папка за папкой.
  const firstPhoto = bg.started.findIndex((d) => d.filename.includes('/Фото/'));
  const lastPhoto = bg.started.map((d) => d.filename.includes('/Фото/')).lastIndexOf(true);
  assert.equal(lastPhoto - firstPhoto + 1, 95, 'файлы одной папки идут подряд');
});

test('ошибки: нет файла, мёртвый узел, сбой сервера, опасный тип, превью вместо оригинала', async () => {
  const tree = {
    '/disk': [
      { name: 'gone.jpg', size: 10, mediaType: 'image' },
      { name: 'dead.jpg', size: 20, mediaType: 'image' },
      { name: 'dead2.jpg', size: 25, mediaType: 'image' },
      { name: 'flaky.bin', size: 30 },
      { name: 'setup.exe', size: 40 },
      { name: 'dead.mp4', size: 50, mediaType: 'video' },
      { name: 'ok.txt', size: 60 },
    ],
  };
  let healed = false; // для второго прохода: Яндекс «починился»
  const source = fakeSource(tree, { link: (p) => (!healed && p === '/disk/gone.jpg' ? 'notfound' : null) });
  let flaky = 0;
  const bg = fakeBg((url, filename) => {
    if (healed) return filename.endsWith('.exe') ? 'danger' : 'ok';
    const u = new URL(url);
    const p = u.searchParams.get('path') || '';
    if (p === '/disk/dead.jpg') return u.pathname.startsWith('/preview') ? 'ok' : 'stall';
    if (p === '/disk/dead2.jpg') return u.pathname.startsWith('/disk/orig') ? 'ok' : 'stall';
    if (p === '/disk/dead.mp4') return 'stall';
    if (p === '/disk/flaky.bin') return flaky++ === 0 ? 'interrupt:SERVER_FAILED' : 'ok';
    if (filename.endsWith('.exe')) return 'danger';
    return 'ok';
  });
  const engine = makeEngine({ source, bg });
  await engine.createJob({ scope: ALL, options: { concurrency: 2, preview: true } });
  await engine.start();
  const st = statusByName(engine);
  assert.equal(engine.job.meta.phase, 'done');
  assert.equal(st['/disk/gone.jpg'], ST.FAILED);
  assert.equal(st['/disk/dead.jpg'], ST.PREVIEW);
  assert.equal(st['/disk/dead2.jpg'], ST.DONE, 'выручила прямая ссылка ORIGINAL');
  assert.equal(st['/disk/flaky.bin'], ST.DONE);
  assert.equal(st['/disk/setup.exe'], ST.CONFIRM);
  assert.equal(st['/disk/dead.mp4'], ST.FAILED);
  assert.equal(st['/disk/ok.txt'], ST.DONE);
  assert.deepEqual(engine.snapshot().active, [], 'после завершения нет «зависших» строк в списке текущих файлов');
  assert.equal(bg.started.filter((d) => d.filename.endsWith('flaky.bin')).length, 2);
  assert.ok(bg.started.some((d) => d.filename === 'Яндекс Диск/dead (превью).jpg'));
  const errors = Object.values(engine.job.meta.errors).join(' | ');
  assert.match(errors, /больше нет на Диске/);
  assert.match(errors, /не отдаёт файл/);
  const report = engine.buildReport();
  assert.ok(report.startsWith('﻿"Путь на Диске"'));
  assert.match(report, /gone\.jpg";"не скачан"/);
  assert.match(report, /dead\.jpg";"сохранено только превью";"Яндекс Диск\/dead \(превью\)\.jpg"/);
  // Повтор неудачных: теперь всё отдаётся.
  assert.equal(engine.snapshot().failed, 2);
  const startedBefore = bg.started.length;
  healed = true;
  await engine.retryFailed();
  const after = statusByName(engine);
  assert.equal(engine.job.meta.phase, 'done');
  assert.equal(engine.job.meta.pass, 2);
  assert.equal(engine.snapshot().failed, 0);
  assert.equal(after['/disk/gone.jpg'], ST.DONE);
  assert.equal(after['/disk/dead.mp4'], ST.DONE);
  assert.equal(after['/disk/dead.jpg'], ST.PREVIEW, 'превью повторно не трогаем — для этого есть отдельная кнопка');
  assert.equal(bg.started.length - startedBefore, 2, 'повторно качали только два неудачных файла');
  await engine.retryPreviews();
  assert.equal(statusByName(engine)['/disk/dead.jpg'], ST.DONE, 'оригинал вместо превью');
  assert.equal(engine.snapshot().preview, 0);
});

test('сервер не ответил на запрос файла или сразу вернул ошибку', async () => {
  const tree = {
    '/disk': [
      { name: 'silent.jpg', size: 10, mediaType: 'image' },
      { name: 'err500.bin', size: 20 },
      { name: 'weird:name.txt', size: 30 },
    ],
  };
  let err = 0;
  let invalid = 0;
  const bg = fakeBg((url, filename) => {
    const u = new URL(url);
    const p = u.searchParams.get('path') || '';
    if (p === '/disk/silent.jpg') return u.pathname.startsWith('/preview') ? 'ok' : 'noresponse';
    if (p === '/disk/err500.bin') return err++ === 0 ? 'startfail:SERVER_FAILED' : 'ok';
    if (filename.includes('weird') && invalid++ === 0) return 'invalid';
    return 'ok';
  });
  const engine = makeEngine({ source: fakeSource(tree), bg });
  await engine.createJob({ scope: ALL, options: { concurrency: 1 } });
  await engine.start();
  const st = statusByName(engine);
  assert.equal(st['/disk/silent.jpg'], ST.PREVIEW, 'молчащий сервер → превью');
  assert.equal(st['/disk/err500.bin'], ST.DONE, 'ошибка сервера при старте → повтор');
  assert.equal(st['/disk/weird:name.txt'], ST.DONE, 'имя отвергнуто → строгий вариант');
  const weird = bg.started.filter((d) => d.filename.includes('weird')).map((d) => d.filename);
  assert.equal(invalid, 2, 'первая попытка отвергнута, вторая — со строгим именем');
  assert.deepEqual(weird, ['Яндекс Диск/weird_name.txt']);
});

test('все байты получены, браузер долго проверяет файл — это не зависание', async () => {
  const tree = { '/disk': [{ name: 'setup.bin', size: 1000 }, { name: 'noext', size: 500 }] };
  const bg = fakeBg(() => 'finishing:900'); // дольше, чем stallMs (250 мс)
  const engine = makeEngine({ source: fakeSource(tree), bg });
  await engine.createJob({ scope: ALL, options: {} });
  await engine.start();
  const s = engine.snapshot();
  assert.equal(s.done, 2, JSON.stringify(engine.job.meta.errors));
  assert.equal(bg.started.length, 2, 'ничего не отменяли и не перезапускали');
});

test('пауза и продолжение после перезапуска вкладки: ничего не качается дважды', async () => {
  const tree = { '/disk': [] };
  for (let d = 0; d < 6; d++) {
    tree['/disk'].push({ name: 'Папка ' + d, type: 'dir' });
    tree['/disk/Папка ' + d] = Array.from({ length: 50 }, (_, i) => ({ name: `f${i}.txt`, size: 10 + i }));
  }
  const area = memoryArea();
  const bg = fakeBg();
  const engine1 = makeEngine({ source: fakeSource(tree, { listDelayMs: 25 }), bg, area });
  await engine1.createJob({ scope: ALL, options: { concurrency: 4 } });
  const run1 = engine1.start();
  while (bg.started.length < 70) await new Promise((r) => setTimeout(r, 5));
  await engine1.pause();
  await run1;
  await engine1.flush(true);
  assert.equal(engine1.job.meta.phase, 'paused');
  assert.ok(engine1.snapshot().scanning, 'обход прерван на середине');
  const doneBefore = engine1.snapshot().done;
  assert.ok(doneBefore >= 66, 'начатые загрузки докачались: ' + doneBefore);

  // Новая вкладка: тот же store, новый движок.
  const engine2 = makeEngine({ source: fakeSource(tree), bg, area });
  const job = await engine2.loadCurrent();
  assert.ok(job, 'задание найдено');
  assert.equal(engine2.snapshot().done, doneBefore);
  await engine2.start();
  const s = engine2.snapshot();
  assert.equal(s.job.phase, 'done');
  assert.equal(s.total, 300);
  assert.equal(s.done, 300);
  const perFile = new Map();
  for (const d of bg.started) perFile.set(d.filename, (perFile.get(d.filename) || 0) + 1);
  assert.equal(perFile.size, 300);
  assert.ok([...perFile.values()].every((n) => n === 1), 'каждый файл скачан ровно один раз');
});

test('загрузка, начатая до перезагрузки страницы, подхватывается', async () => {
  const tree = { '/disk': [{ name: 'big.mkv', size: 500 }] };
  const area = memoryArea();
  const slow = fakeBg(() => 'stall');
  const engine1 = makeEngine({ source: fakeSource(tree), bg: slow, area });
  engine1.timing.firstByteMs = 60000;
  await engine1.createJob({ scope: ALL, options: {} });
  engine1.start();
  while (!slow.started.length) await new Promise((r) => setTimeout(r, 5));
  await engine1.flush(true);
  const id = slow.started[0].id;
  // Вкладку закрыли, а браузер докачал файл сам.
  Object.assign(slow.items.get(id), { state: 'complete', bytesReceived: 500, fileSize: 500, filename: '/x' });
  engine1.token++; // старый движок «умер» вместе со вкладкой
  const engine2 = makeEngine({ source: fakeSource(tree), bg: slow, area });
  await engine2.loadCurrent();
  assert.equal(engine2.interrupted, true);
  await engine2.start();
  assert.equal(engine2.snapshot().done, 1);
  assert.equal(slow.started.length, 1, 'повторно не скачивали');
});

test('выделенное: только отмеченные файлы и папки', async () => {
  const tree = {
    '/disk/Фото': [
      { name: 'A', type: 'dir' },
      { name: 'B', type: 'dir' },
      { name: 'one.jpg', size: 1 },
      { name: 'two.jpg', size: 2 },
    ],
    '/disk/Фото/A': [{ name: 'a1.jpg', size: 3 }],
    '/disk/Фото/B': [{ name: 'b1.jpg', size: 4 }],
  };
  const bg = fakeBg();
  const engine = makeEngine({ source: fakeSource(tree), bg });
  await engine.createJob({
    scope: { type: 'selection', label: 'sel', roots: [{ path: '/disk/Фото', local: 'Фото', filter: ['A', 'two.jpg'] }] },
    options: {},
  });
  await engine.start();
  assert.deepEqual(bg.started.map((d) => d.filename).sort(), ['Яндекс Диск/Фото/A/a1.jpg', 'Яндекс Диск/Фото/two.jpg']);
});

test('безлимит: собираем фото из раздела «Фото», в том числе большие кластеры', async () => {
  const requests = [];
  const clusterItems = {
    c1: ['/disk/Фото/x.jpg', '/photounlim/u1.jpg', '/photounlim/u2.jpg'],
    c2: Array.from({ length: 250 }, (_, i) => `/photounlim/IMG_${i}.jpg`),
  };
  const photoslice = {
    id: 'ps1',
    clusters: [
      { id: 'c1', size: 3, unlim: 2 },
      { id: 'c3', size: 5, unlim: 0 },
      { id: 'c2', size: 250, unlim: 250 },
    ],
    resources(request) {
      requests.push(request);
      const out = [];
      for (const [cid, [from, to]] of Object.entries(request)) {
        for (const id of clusterItems[cid].slice(from, to + 1)) {
          out.push({ id, name: YDD.basename(id), type: 'file', size: 100, mediaType: 'image', sizes: null, partial: false });
        }
      }
      return out;
    },
  };
  const tree = { '/disk': [] };
  const bg = fakeBg();
  const engine = makeEngine({ source: fakeSource(tree, { photoslice }), bg });
  await engine.createJob({ scope: Object.assign({}, ALL, { unlim: true }), options: {} });
  await engine.start();
  const s = engine.snapshot();
  assert.equal(s.unlim.state, 'done');
  assert.equal(s.unlim.found, 252);
  assert.equal(s.done, 252);
  assert.ok(bg.started.every((d) => d.filename.startsWith('Яндекс Диск/Фото из безлимита/')));
  assert.ok(requests.every((r) => Object.values(r).reduce((n, [a, b]) => n + b - a + 1, 0) <= 200), 'не больше 200 файлов за запрос');
  assert.ok(!requests.some((r) => r.c3), 'кластеры без безлимита не запрашиваем');
});

test('новое задание не качает заново то, что уже скачано', async () => {
  const tree = { '/disk': [{ name: 'a.txt', size: 1 }, { name: 'b.txt', size: 2 }] };
  const bg = fakeBg();
  const engine = makeEngine({ source: fakeSource(tree), bg });
  await engine.createJob({ scope: ALL, options: {} });
  await engine.start();
  assert.equal(bg.started.length, 2);
  tree['/disk'].push({ name: 'c.txt', size: 3 });
  tree['/disk'][0].size = 11; // a.txt изменился
  const carry = engine.doneMap();
  await engine.discard();
  await engine.createJob({ scope: ALL, options: {}, carry });
  await engine.start();
  const again = bg.started.slice(2).map((d) => d.filename).sort();
  assert.deepEqual(again, ['Яндекс Диск/a.txt', 'Яндекс Диск/c.txt']);
  assert.equal(engine.snapshot().reused, 1);
});

test('сессия истекла — задание встаёт на паузу и ждёт пользователя', async () => {
  const tree = { '/disk': [{ name: 'a.txt' }, { name: 'b.txt' }] };
  const bg = fakeBg();
  const engine = makeEngine({ source: fakeSource(tree, { link: () => 'auth' }), bg });
  await engine.createJob({ scope: ALL, options: { concurrency: 1 } });
  await engine.start();
  const s = engine.snapshot();
  assert.equal(s.job.phase, 'paused');
  assert.equal(s.blocked.kind, 'auth');
  assert.equal(s.pending, 2, 'файлы остались в очереди');
  assert.equal(bg.started.length, 0);
});

test('браузер спрашивает «Сохранить как» — останавливаемся', async () => {
  const tree = { '/disk': [{ name: 'a.txt' }, { name: 'b.txt' }, { name: 'c.txt' }] };
  const bg = fakeBg(() => 'stall');
  // Имя файла не назначается — так выглядит открытое окно «Сохранить как».
  const origStart = bg.startDownload;
  bg.startDownload = async function (o) {
    const res = await origStart.call(this, o);
    setTimeout(() => (bg.items.get(res.id).filename = ''), 10);
    return res;
  };
  const engine = makeEngine({ source: fakeSource(tree), bg });
  engine.timing.firstByteMs = 60000;
  await engine.createJob({ scope: ALL, options: { concurrency: 1 } });
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  try {
    const run = engine.start();
    while (!bg.started.length) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 30));
    shift = 11000;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(engine.snapshot().blocked && engine.snapshot().blocked.kind, 'saveas');
    assert.equal(engine.job.meta.phase, 'paused');
    engine.monitor.cancelAll();
    await run;
  } finally {
    Date.now = realNow;
  }
  assert.equal(bg.started.length, 1, 'новых загрузок не начинали');
});

// --- API веб-версии ------------------------------------------------------------------
function withFetch(handler, fn) {
  const saved = globalThis.fetch;
  const savedLoc = globalThis.location;
  globalThis.location = { href: 'https://disk.yandex.ru/client/disk', origin: 'https://disk.yandex.ru' };
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = saved;
    globalThis.location = savedLoc;
  });
}
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) });

test('PrivateApi: формат запроса и обновление sk по ошибке CKEY', async () => {
  const bodies = [];
  await withFetch(
    async (url, init) => {
      bodies.push({ url, init, body: JSON.parse(init.body) });
      if (bodies.length === 1) return json(400, { error: { code: 'CKEY', ckey: 'NEW_SK:123', uid: '42' } });
      return json(200, { file: '//downloader.disk.yandex.ru/disk/abc?x=1' });
    },
    async () => {
      const api = new YDD.PrivateApi({ origin: 'https://disk.yandex.ru', sk: 'OLD', connectionId: 'conn', uid: '42' }, { gapMs: 0 });
      const url = await api.getFileUrl('/disk/Фото/a.jpg');
      assert.equal(url, 'https://downloader.disk.yandex.ru/disk/abc?x=1');
      assert.equal(api.sk, 'NEW_SK:123');
    }
  );
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].url, 'https://disk.yandex.ru/models-v2?m=mpfs/url');
  assert.equal(bodies[0].init.method, 'POST');
  assert.equal(bodies[0].init.credentials, 'same-origin');
  assert.equal(bodies[0].init.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.deepEqual(bodies[0].body, { sk: 'OLD', connection_id: 'conn', apiMethod: 'mpfs/url', requestParams: { path: '/disk/Фото/a.jpg' } });
  assert.equal(bodies[1].body.sk, 'NEW_SK:123');
});

test('PrivateApi: 429 → пауза и повтор, 5xx → повтор, капча → стоп', async () => {
  let n = 0;
  const waits = [];
  await withFetch(
    async () => {
      n++;
      if (n === 1) return json(429, { error: { code: 'TOO_MANY_REQUESTS' } }, { 'Retry-After': '1' });
      if (n === 2) return json(502, {});
      return json(200, { resources: [{ id: '/disk/A', type: 'dir', name: 'A' }], countLost: 0 });
    },
    async () => {
      const api = new YDD.PrivateApi({ origin: 'https://disk.yandex.ru', sk: 's', uid: '1' }, { gapMs: 0, retryBaseMs: 20 });
      api.onRateLimit = (ms) => waits.push(ms);
      const t0 = Date.now();
      const page = await api.listDir('/disk', null);
      assert.ok(Date.now() - t0 >= 950, 'выждали Retry-After');
      assert.deepEqual(waits, [1000]);
      assert.equal(page.items.length, 1);
      assert.equal(page.next, null, 'меньше 40 — папка прочитана');
    }
  );
  await withFetch(
    async () => json(200, { type: 'captcha', captcha: { 'captcha-page': 'https://disk.yandex.ru/showcaptcha?x' } }),
    async () => {
      const api = new YDD.PrivateApi({ origin: 'https://disk.yandex.ru', sk: 's', uid: '1' }, { gapMs: 0 });
      await assert.rejects(api.getFileUrl('/disk/a'), (e) => e.kind === 'captcha' && e.fatal && e.captchaUrl.includes('showcaptcha'));
    }
  );
  await withFetch(
    async () => json(401, { error: { code: 'NO_AUTH' } }),
    async () => {
      const api = new YDD.PrivateApi({ origin: 'https://disk.yandex.ru', sk: 's', uid: '1' }, { gapMs: 0 });
      await assert.rejects(api.listDir('/disk', null), (e) => e.kind === 'auth' && e.fatal);
    }
  );
  await withFetch(
    async () => json(404, { error: { code: 'HTTP_404', title: 'Resource not found' } }),
    async () => {
      const api = new YDD.PrivateApi({ origin: 'https://disk.yandex.ru', sk: 's', uid: '1' }, { gapMs: 0 });
      await assert.rejects(api.getFileUrl('/disk/a'), (e) => e.kind === 'notfound');
    }
  );
});

test('PrivateApi.listDir: порции, countLost, iteration_key', async () => {
  const sent = [];
  const pages = [
    { resources: Array.from({ length: 40 }, (_, i) => ({ id: '/disk/f' + i, name: 'f' + i, type: 'file', meta: { size: i, mediatype: 'image', sizes: [] } })) },
    { resources: Array.from({ length: 38 }, (_, i) => ({ id: '/disk/g' + i, name: 'g' + i, type: 'file', meta: {} })), countLost: 2 },
    { resources: [{ id: '/disk/h', name: 'h', type: 'file', meta: {} }] },
  ];
  await withFetch(
    async (url, init) => {
      sent.push(JSON.parse(init.body).requestParams);
      return json(200, pages[sent.length - 1]);
    },
    async () => {
      const api = new YDD.PrivateApi({ origin: 'https://disk.yandex.ru', sk: 's', uid: '1' }, { gapMs: 0 });
      const p1 = await api.listDir('/disk', null);
      assert.deepEqual(p1.next, { offset: 40, iterationKey: null });
      assert.equal(p1.items[3].size, 3);
      assert.equal(p1.items[3].mediaType, 'image');
      const p2 = await api.listDir('/disk', p1.next);
      assert.ok(p2.next, '38 + 2 потерянных = 40 — читаем дальше');
      const p3 = await api.listDir('/disk', p2.next);
      assert.equal(p3.next, null);
    }
  );
  assert.deepEqual(sent[0], { idContext: '/disk', sort: 'name', order: '1', amount: 40, with_share: '1', offset: 0 });
  assert.equal(sent[1].offset, 40);
  assert.equal(sent[2].offset, 78);
});

test('PrivateApi.readEnv читает данные страницы', () => {
  const data = {
    config: { sk: 'abc:1', idClient: 'client123' },
    userCurrent: { uid: '777', login: 'user' },
    space: { files_count: 10, used: 100, photounlim: 5 },
  };
  const doc = {
    getElementById: (id) => (id === 'preloaded-data' ? { textContent: JSON.stringify(data) } : null),
    documentElement: { innerHTML: '' },
  };
  const env = YDD.PrivateApi.readEnv(doc, { origin: 'https://disk.yandex.ru' });
  assert.deepEqual(
    { sk: env.sk, connectionId: env.connectionId, uid: env.uid, login: env.login, unlim: env.photounlimAvailable },
    { sk: 'abc:1', connectionId: 'client123', uid: '777', login: 'user', unlim: true }
  );
  const fallback = YDD.PrivateApi.readEnv(
    { getElementById: () => null, documentElement: { innerHTML: '<script>{"sk":"zzz:9","x":1}</script>' } },
    { origin: 'https://disk.yandex.ru' }
  );
  assert.equal(fallback.sk, 'zzz:9');
});

test('PublicApi: список и ссылка через официальный REST API', async () => {
  const urls = [];
  await withFetch(
    async (url) => {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith('/download')) return json(200, { href: 'https://downloader.disk.yandex.ru/disk/pub?x', method: 'GET' });
      const offset = Number(u.searchParams.get('offset'));
      const items = offset === 0 ? Array.from({ length: 100 }, (_, i) => ({ type: 'file', name: `f${i}`, path: `/f${i}`, size: i })) : [{ type: 'dir', name: 'Sub', path: '/Sub' }];
      return json(200, { type: 'dir', name: 'Shared', path: '/', _embedded: { items, total: 101, limit: 100, offset } });
    },
    async () => {
      const api = new YDD.PublicApi({ publicKey: 'https://disk.yandex.ru/d/HASH', gapMs: 0 });
      const p1 = await api.listDir('/', null);
      assert.equal(p1.items.length, 100);
      assert.deepEqual(p1.next, { offset: 100 });
      const p2 = await api.listDir('/', p1.next);
      assert.equal(p2.next, null);
      assert.equal(p2.items[0].type, 'dir');
      assert.equal(await api.getFileUrl('/f1'), 'https://downloader.disk.yandex.ru/disk/pub?x');
    }
  );
  const first = new URL(urls[0]);
  assert.equal(first.origin + first.pathname, 'https://cloud-api.yandex.net/v1/disk/public/resources');
  assert.equal(first.searchParams.get('public_key'), 'https://disk.yandex.ru/d/HASH');
});

// --- Перенос в облако и на сервер ---------------------------------------------------
test('подпись AWS SigV4 совпадает с примерами из документации AWS', async () => {
  const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };
  const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const base = 'https://examplebucket.s3.amazonaws.com';
  const cases = [
    ['GET', '/test.txt', { range: 'bytes=0-9' }, EMPTY, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'],
    ['PUT', '/test%24file.text', { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072', '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd'],
    ['GET', '/?lifecycle', {}, EMPTY, 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543'],
    ['GET', '/?max-keys=2&prefix=J', {}, EMPTY, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7'],
  ];
  for (const [method, p, headers, payloadHash, expected] of cases) {
    const s = await YDD.signV4(Object.assign({ method, url: base + p, payloadHash, headers: Object.assign({ 'x-amz-date': '20130524T000000Z' }, headers) }, creds));
    assert.equal(s.signature, expected, `${method} ${p}`);
  }
  assert.equal(YDD.uriEncode('test$file.text'), 'test%24file.text');
  assert.equal(YDD.uriEncode('Фото 1 (копия)~.jpg'), '%D0%A4%D0%BE%D1%82%D0%BE%201%20%28%D0%BA%D0%BE%D0%BF%D0%B8%D1%8F%29~.jpg');
  assert.equal(YDD.basicAuth('user', 'пароль'), 'Basic ' + Buffer.from('user:пароль').toString('base64'));
});

/** Источник данных для переноса: n байт порциями по 1 МБ. */
function bytesSource(n, fill = 7) {
  return {
    size: n,
    async *chunks() {
      for (let left = n; left > 0; left -= 1 << 20) yield new Uint8Array(Math.min(left, 1 << 20)).fill(fill);
    },
  };
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      handler(req, res, Buffer.concat(chunks));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('WebDAV: папки создаются по очереди, файл ложится по нужному пути', async () => {
  const files = new Map();
  const dirs = new Set(['/dav/Backup']);
  const log = [];
  const auth = 'Basic ' + Buffer.from('аня:секрет').toString('base64');
  const { server, url } = await startServer((req, res, body) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '');
    log.push(`${req.method} ${p}`);
    if (req.headers.authorization !== auth) return res.writeHead(401).end();
    const parent = p.slice(0, p.lastIndexOf('/'));
    if (req.method === 'PROPFIND') return res.writeHead(dirs.has(p) ? 207 : 404).end();
    if (req.method === 'MKCOL') {
      if (dirs.has(p)) return res.writeHead(405).end();
      if (!dirs.has(parent)) return res.writeHead(409).end();
      dirs.add(p);
      return res.writeHead(201).end();
    }
    if (req.method === 'PUT') {
      if (!dirs.has(parent)) return res.writeHead(409).end();
      files.set(p, body);
      return res.writeHead(201).end();
    }
    if (req.method === 'DELETE') {
      files.delete(p);
      return res.writeHead(204).end();
    }
    res.writeHead(405).end();
  });
  try {
    const dav = YDD.createDestination({ type: 'webdav', url: url + '/dav/Backup/', username: 'аня', password: 'секрет' });
    assert.equal(await dav.test(), true);
    assert.equal(files.size, 0, 'пробный файл удалён');
    const progress = [];
    await dav.upload('Яндекс Диск/Фото/2019/IMG 1.jpg', bytesSource(3 << 20), { onProgress: (n) => progress.push(n) });
    await dav.upload('Яндекс Диск/Фото/2019/IMG 2.jpg', bytesSource(10, 1), {});
    assert.equal(files.get('/dav/Backup/Яндекс Диск/Фото/2019/IMG 1.jpg').length, 3 << 20);
    assert.equal(files.get('/dav/Backup/Яндекс Диск/Фото/2019/IMG 2.jpg').length, 10);
    assert.equal(progress[progress.length - 1], 3 << 20);
    assert.equal(log.filter((l) => l.startsWith('MKCOL')).length, 3, 'каждая папка создаётся один раз');
    const bad = YDD.createDestination({ type: 'webdav', url: url + '/dav/Backup', username: 'аня', password: 'не тот' });
    await assert.rejects(bad.test(), (e) => e.code === 'DEST_AUTH');
  } finally {
    server.close();
  }
});

test('S3: маленький файл одним запросом, большой — по частям', async () => {
  const objects = new Map();
  const uploads = new Map();
  const requests = [];
  const { server, url } = await startServer(async (req, res, body) => {
    const u = new URL(req.url, 'http://x');
    requests.push(`${req.method} ${u.search || '(object)'}`);
    // Сервер пересчитывает подпись по тем же правилам: так ловятся расхождения в кодировании путей.
    const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})/.exec(req.headers.authorization || '');
    if (!m || req.headers['x-amz-content-sha256'] !== 'UNSIGNED-PAYLOAD') return res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>');
    const expected = await YDD.signV4({
      method: req.method,
      url: `http://${req.headers.host}${req.url}`,
      headers: { 'x-amz-date': req.headers['x-amz-date'] },
      payloadHash: 'UNSIGNED-PAYLOAD',
      accessKeyId: 'KEY',
      secretAccessKey: 'SECRET',
      region: 'ru-1',
    });
    if (expected.signature !== m[5]) return res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
    const key = decodeURIComponent(u.pathname);
    if (req.method === 'PUT' && !u.searchParams.has('partNumber')) {
      objects.set(key, body);
      return res.writeHead(200, { ETag: '"x"' }).end();
    }
    if (req.method === 'POST' && u.searchParams.has('uploads')) {
      uploads.set('UP-1', []);
      return res.writeHead(200).end('<InitiateMultipartUploadResult><UploadId>UP-1</UploadId></InitiateMultipartUploadResult>');
    }
    if (req.method === 'PUT' && u.searchParams.has('partNumber')) {
      uploads.get(u.searchParams.get('uploadId'))[Number(u.searchParams.get('partNumber')) - 1] = body;
      return res.writeHead(200, { ETag: `"p${u.searchParams.get('partNumber')}"` }).end();
    }
    if (req.method === 'POST' && u.searchParams.has('uploadId')) {
      const tags = [...body.toString().matchAll(/<ETag>&quot;(p\d+)&quot;<\/ETag>/g)].map((x) => x[1]);
      const parts = uploads.get(u.searchParams.get('uploadId'));
      assert.deepEqual(tags, parts.map((_, i) => `p${i + 1}`));
      objects.set(key, Buffer.concat(parts));
      return res.writeHead(200).end('<CompleteMultipartUploadResult/>');
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      return res.writeHead(204).end();
    }
    res.writeHead(400).end();
  });
  try {
    const s3 = YDD.createDestination({ type: 's3', endpoint: url, region: 'ru-1', bucket: 'backup', prefix: '/архив/', accessKeyId: 'KEY', secretAccessKey: 'SECRET', partSizeMB: 5 });
    assert.equal(await s3.test(), true);
    await s3.upload('Яндекс Диск/Документы/Договор (1).pdf', bytesSource(1 << 20), {});
    assert.equal(objects.get('/backup/архив/Яндекс Диск/Документы/Договор (1).pdf').length, 1 << 20);
    const progress = [];
    await s3.upload('Яндекс Диск/Видео/Отпуск.mov', bytesSource(12 << 20, 3), { onProgress: (n) => progress.push(n) });
    const big = objects.get('/backup/архив/Яндекс Диск/Видео/Отпуск.mov');
    assert.equal(big.length, 12 << 20);
    assert.equal(requests.filter((r) => r.includes('partNumber')).length, 3, '5 + 5 + 2 МБ');
    assert.equal(progress[progress.length - 1], 12 << 20);
    const wrong = YDD.createDestination({ type: 's3', endpoint: url, region: 'ru-1', bucket: 'backup', accessKeyId: 'KEY', secretAccessKey: 'WRONG' });
    await assert.rejects(wrong.test(), (e) => e.code === 'DEST_AUTH');
  } finally {
    server.close();
  }
});

test('перенос в облако: те же папки, повтор при сбое сети, стоп при отказе облака', async () => {
  const tree = { '/disk': [{ name: 'Фото', type: 'dir' }, { name: 'a.txt', size: 5 }], '/disk/Фото': [{ name: 'b.jpg', size: 6, mediaType: 'image' }] };
  let flaky = 0;
  const bg = fakeBg((url) => {
    const p = new URL(url).searchParams.get('path');
    if (p === '/disk/Фото/b.jpg') return flaky++ === 0 ? 'interrupt:DEST_NETWORK' : 'ok';
    return 'ok';
  });
  const engine = makeEngine({ source: fakeSource(tree), bg });
  await engine.createJob({ scope: ALL, options: { dest: { type: 'webdav', label: 'WebDAV · cloud.example.com' } } });
  await engine.start();
  const s = engine.snapshot();
  assert.equal(s.job.phase, 'done');
  assert.equal(s.done, 2);
  assert.deepEqual(s.job.dest, { type: 'webdav', label: 'WebDAV · cloud.example.com' });
  assert.ok(bg.started.every((d) => d.remote), 'всё ушло в облако, а не в «Загрузки»');
  assert.deepEqual([...new Set(bg.started.map((d) => d.filename))].sort(), ['Яндекс Диск/a.txt', 'Яндекс Диск/Фото/b.jpg']);
  assert.match(engine.buildReport(), /"Куда сохранён"/);

  const denied = fakeBg(() => 'interrupt:DEST_AUTH');
  const engine2 = makeEngine({ source: fakeSource(tree), bg: denied });
  await engine2.createJob({ scope: ALL, options: { concurrency: 1, dest: { type: 's3', label: 'S3 · backup' } } });
  await engine2.start();
  const s2 = engine2.snapshot();
  assert.equal(s2.job.phase, 'paused');
  assert.equal(s2.blocked.kind, 'dest');
  assert.match(s2.blocked.message, /проверьте настройки/);
  assert.equal(s2.failed, 0, 'файлы не помечены как неудачные — ждут исправления настроек');
});

// --- ZIP-архив ------------------------------------------------------------------------
async function* chunked(buf, step = 4096) {
  for (let i = 0; i < buf.length; i += step) yield new Uint8Array(buf.subarray(i, i + step));
}

test('ZIP: CRC-32, сжатие только там, где оно помогает', async () => {
  assert.equal(YDD.crc32Update(0, Buffer.from('123456789')), 0xcbf43926);
  assert.equal(YDD.crc32Update(YDD.crc32Update(0, Buffer.from('1234')), Buffer.from('56789')), 0xcbf43926, 'по частям — то же');
  assert.equal(YDD.shouldCompress('Отчёт.docx'), false);
  assert.equal(YDD.shouldCompress('IMG_0001.JPG'), false);
  assert.equal(YDD.shouldCompress('Видео.mov'), false);
  assert.equal(YDD.shouldCompress('таблица.csv'), true);
  assert.equal(YDD.shouldCompress('скан.tiff'), true);
  const text = await YDD.prepareEntry('a.txt', chunked(Buffer.from('ab'.repeat(50000))));
  assert.equal(text.method, 8);
  assert.ok(text.data.size < 1000, 'текст сжат: ' + text.data.size);
  const noise = require('node:crypto').randomBytes(30000);
  const random = await YDD.prepareEntry('a.bin', chunked(noise));
  assert.equal(random.method, 0, 'несжимаемое кладём как есть');
  assert.equal(random.data.size, 30000);
  const photo = await YDD.prepareEntry('a.jpg', chunked(Buffer.alloc(5000, 1)));
  assert.equal(photo.method, 0, 'фото не сжимаем');
  const forced = await YDD.prepareEntry('a.jpg', chunked(Buffer.alloc(5000, 1)), { compress: true });
  assert.equal(forced.method, 8, '«Сжимать и фото» включено');
});

test('ZIP: архив читается независимо и стандартными распаковщиками, в том числе ZIP64', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydd-zip-'));
  try {
    const files = [
      ['Фото/Отпуск 2019/IMG_0001.jpg', Buffer.alloc(7000, 9), '2019-07-14T10:20:30Z'],
      ['Документы/отчёт «итоги».txt', Buffer.from('Строка отчёта\n'.repeat(3000)), '2021-03-01T08:00:00Z'],
      ['пустой файл.txt', Buffer.alloc(0), '2020-01-01T00:00:00Z'],
      ['данные.bin', require('node:crypto').randomBytes(50000), '2024-12-31T23:59:58Z'],
    ];
    for (const forceZip64 of [false, true]) {
      const volume = new YDD.ZipVolume({ forceZip64 });
      for (const [name, buf, date] of files) volume.add(await YDD.prepareEntry(name, chunked(buf), { mtime: new Date(date) }));
      const zip = Buffer.from(await volume.finish().arrayBuffer());
      const { entries, zip64 } = readZip(zip);
      assert.equal(zip64, forceZip64);
      assert.deepEqual(entries.map((e) => e.name), files.map((f) => f[0]));
      entries.forEach((e, i) => {
        assert.ok(e.data.equals(files[i][1]), 'содержимое ' + e.name);
        assert.ok(e.utf8, 'имя помечено как UTF-8');
        assert.equal(e.mtime, Date.parse(files[i][2]) / 1000, 'дата ' + e.name);
      });
      const file = path.join(dir, forceZip64 ? 'z64.zip' : 'plain.zip');
      fs.writeFileSync(file, zip);
      // Независимые распаковщики: unzip (Info-ZIP) и zipfile из Python, если они есть в системе.
      try {
        execFileSync('unzip', ['-tqq', file], { stdio: 'pipe' });
      } catch (e) {
        if (e.code !== 'ENOENT') assert.fail('unzip -t: ' + (e.stdout || '') + (e.stderr || ''));
      }
      try {
        const out = execFileSync('python3', ['-I', '-c', 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint("\\n".join(i.filename for i in z.infolist()))', file], { encoding: 'utf8' });
        assert.deepEqual(out.trim().split('\n'), files.map((f) => f[0]));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const ZIP_TREE = {
  '/disk/Фото': [
    { name: 'A', type: 'dir' },
    { name: 'one.jpg', size: 400 },
    { name: 'two.txt', size: 300 },
    { name: 'three.txt', size: 300 },
    { name: 'big.mov', size: 900 },
    { name: 'skip.txt', size: 5 },
  ],
  '/disk/Фото/A': [
    { name: 'a1.jpg', size: 200 },
    { name: 'a2.jpg', size: 200 },
  ],
};
const ZIP_SCOPE = {
  type: 'selection',
  label: 'Выделенное в «Фото»: 5',
  roots: [{ path: '/disk/Фото', local: '', filter: ['A', 'one.jpg', 'two.txt', 'three.txt', 'big.mov'] }],
};
const ZIP_FILES = ['A/a1.jpg', 'A/a2.jpg', 'big.mov', 'one.jpg', 'three.txt', 'two.txt'];
const zipOptions = (extra) => ({ concurrency: 3, dest: Object.assign({ type: 'zip', label: 'ZIP-архив', name: 'Фото (выбранное) 2026-10-20 14-30' }, extra) });

function savedPaths(bg) {
  return bg.savedParts.flatMap((p) => p.paths).sort();
}

test('архив: выделенное ложится в части не больше заданного размера, каждый файл один раз', async () => {
  const bg = fakeBg();
  const engine = makeEngine({ source: fakeSource(ZIP_TREE), bg });
  engine.timing.zipPartBytes = 600;
  await engine.createJob({ scope: ZIP_SCOPE, options: zipOptions() });
  await engine.start();
  const s = engine.snapshot();
  assert.equal(s.job.phase, 'done');
  assert.equal(s.done, 6);
  assert.equal(s.zipped, 0);
  assert.ok(bg.started.every((d) => d.zip), 'файлы шли в архив, а не в «Загрузки»');
  assert.deepEqual(savedPaths(bg), ZIP_FILES, 'в сохранённых частях все файлы ровно по одному разу');
  for (const part of bg.savedParts) {
    assert.ok(part.bytes <= 600 || part.paths.length === 1, `часть ${part.n}: ${part.bytes} байт`);
    assert.match(part.filename, new RegExp(`^Яндекс Диск/Фото \\(выбранное\\) 2026-10-20 14-30, часть ${part.n}\\.zip$`));
  }
  assert.ok(bg.savedParts.length >= 3);
  assert.equal(s.zip.parts, bg.savedParts.length);
  assert.equal(s.zip.bytes, 2300);
  assert.equal(bg.archives.get(engine.job.meta.id).sealed.size, 0, 'сохранённые части освобождены');

  // Всё влезло в одну часть — архив без номера части.
  const bg2 = fakeBg();
  const engine2 = makeEngine({ source: fakeSource(ZIP_TREE), bg: bg2 });
  await engine2.createJob({ scope: ZIP_SCOPE, options: zipOptions() });
  await engine2.start();
  assert.equal(engine2.snapshot().job.phase, 'done');
  assert.deepEqual(bg2.savedParts.map((p) => p.filename), ['Яндекс Диск/Фото (выбранное) 2026-10-20 14-30.zip']);
  assert.deepEqual(savedPaths(bg2), ZIP_FILES);
});

test('архив: перезагрузка страницы — несохранённая часть цела, файлы не качаются заново', async () => {
  const tree = { '/disk': Array.from({ length: 40 }, (_, i) => ({ name: `f${String(i).padStart(2, '0')}.txt`, size: 10 })) };
  const expected = tree['/disk'].map((f) => f.name).sort();
  const area = memoryArea();
  const bg = fakeBg();
  const engine1 = makeEngine({ source: fakeSource(tree), bg, area });
  await engine1.createJob({ scope: ALL, options: zipOptions({ name: 'Диск' }) });
  const run1 = engine1.start();
  while (bg.started.length < 15) await new Promise((r) => setTimeout(r, 2));
  await engine1.pause();
  await run1;
  await engine1.flush(true);
  const zippedBefore = engine1.snapshot().zipped;
  assert.ok(zippedBefore >= 15, 'файлы лежат в несохранённой части: ' + zippedBefore);
  assert.equal(bg.savedParts.length, 0);

  const engine2 = makeEngine({ source: fakeSource(tree), bg, area });
  await engine2.loadCurrent();
  assert.equal(engine2.snapshot().zipped, zippedBefore, 'статусы восстановлены из хранилища');
  await engine2.start();
  assert.equal(engine2.snapshot().job.phase, 'done');
  assert.deepEqual(savedPaths(bg), expected);
  assert.equal(new Set(bg.started.map((d) => d.filename)).size, bg.started.length, 'ни один файл не скачан дважды');
  assert.deepEqual(bg.savedParts.map((p) => p.filename), ['Яндекс Диск/Диск.zip']);
});

test('архив: перезапуск браузера — пропавшую часть собираем заново', async () => {
  const tree = { '/disk': Array.from({ length: 30 }, (_, i) => ({ name: `f${String(i).padStart(2, '0')}.txt`, size: 10 })) };
  const expected = tree['/disk'].map((f) => f.name).sort();
  const area = memoryArea();
  const bg = fakeBg();
  const engine1 = makeEngine({ source: fakeSource(tree), bg, area });
  engine1.timing.zipPartBytes = 100; // по 10 файлов в части
  await engine1.createJob({ scope: ALL, options: zipOptions({ name: 'Диск' }) });
  const run1 = engine1.start();
  while (bg.savedParts.length < 1 || bg.started.length < 15) await new Promise((r) => setTimeout(r, 2));
  await engine1.pause();
  await run1;
  await engine1.flush(true);
  const savedBefore = bg.savedParts.length;
  assert.ok(engine1.snapshot().zipped > 0, 'есть файлы в несохранённой части');

  bg.restartBrowser();
  const engine2 = makeEngine({ source: fakeSource(tree), bg, area });
  engine2.timing.zipPartBytes = 100;
  await engine2.loadCurrent();
  await engine2.start();
  const s = engine2.snapshot();
  assert.equal(s.job.phase, 'done');
  assert.equal(s.done, 30);
  assert.deepEqual(savedPaths(bg), expected, 'каждый файл ровно в одной сохранённой части');
  const numbers = bg.savedParts.map((p) => p.n);
  assert.equal(new Set(numbers).size, numbers.length, 'номера частей не повторяются: ' + numbers);
  assert.ok(numbers.slice(savedBefore).every((n) => n > savedBefore), 'новые части нумеруются после сохранённых');
});

test('архив: нет места для сохранения части — пауза, после «Продолжить» сохраняется', async () => {
  const bg = fakeBg();
  let attempts = 0;
  bg.zipSavePlan = () => (attempts++ === 0 ? 'interrupt:FILE_NO_SPACE' : 'ok');
  const engine = makeEngine({ source: fakeSource(ZIP_TREE), bg });
  await engine.createJob({ scope: ZIP_SCOPE, options: zipOptions() });
  await engine.start();
  let s = engine.snapshot();
  assert.equal(s.job.phase, 'paused');
  assert.equal(s.blocked.kind, 'nospace');
  assert.equal(s.zipped, 6, 'файлы ждут в части архива');
  await engine.start();
  s = engine.snapshot();
  assert.equal(s.job.phase, 'done');
  assert.deepEqual(savedPaths(bg), ZIP_FILES);
  assert.equal(bg.started.length, 6, 'заново ничего не скачивали');

  // Часть дважды не записалась (повреждена) — её файлы скачиваются заново в новую часть.
  const bad = fakeBg();
  bad.zipSavePlan = (n) => (n === 1 ? 'interrupt:FILE_FAILED' : 'ok');
  const engine2 = makeEngine({ source: fakeSource(ZIP_TREE), bg: bad });
  await engine2.createJob({ scope: ZIP_SCOPE, options: zipOptions() });
  await engine2.start();
  assert.equal(engine2.snapshot().blocked.kind, 'zip');
  await engine2.start();
  assert.equal(engine2.snapshot().blocked.kind, 'zip');
  assert.match(engine2.snapshot().blocked.message, /скачаются заново/);
  await engine2.start();
  assert.equal(engine2.snapshot().job.phase, 'done');
  assert.deepEqual(savedPaths(bad), ZIP_FILES);
  assert.deepEqual(bad.savedParts.map((p) => p.filename), ['Яндекс Диск/Фото (выбранное) 2026-10-20 14-30, часть 2.zip']);
});

test('архив: превью вместо «мёртвого» оригинала и отказ от задания', async () => {
  const tree = { '/disk': [{ name: 'dead.jpg', size: 50, mediaType: 'image' }, { name: 'ok.txt', size: 10 }] };
  const bg = fakeBg((url) => (/dead\.jpg/.test(url) && !/preview/.test(url) ? 'interrupt:SERVER_FAILED' : 'ok'));
  const engine = makeEngine({ source: fakeSource(tree), bg });
  await engine.createJob({ scope: ALL, options: zipOptions({ name: 'Диск' }) });
  await engine.start();
  const s = engine.snapshot();
  assert.equal(s.job.phase, 'done');
  assert.equal(s.preview, 1);
  assert.deepEqual(savedPaths(bg), ['dead (превью).jpg', 'ok.txt']);
  assert.match(engine.buildReport(), /dead\.jpg";"сохранено только превью";"ZIP-архив \/ dead \(превью\)\.jpg"/);

  const bg2 = fakeBg(() => 'stall');
  const engine2 = makeEngine({ source: fakeSource(tree), bg: bg2 });
  engine2.timing.firstByteMs = 60000;
  await engine2.createJob({ scope: ALL, options: zipOptions({ name: 'Диск' }) });
  engine2.start();
  while (!bg2.started.length) await new Promise((r) => setTimeout(r, 2));
  bg2.archives.set(engine2.job.meta.id, { next: 1, open: null, sealed: new Map(), placed: new Map() });
  await engine2.discard();
  assert.equal(bg2.archives.size, 0, 'части архива освобождены');
});

test('архив: пауза и сразу «Продолжить» — файлы, лёгшие в архив во время сверки, не качаются заново', async () => {
  const tree = { '/disk': Array.from({ length: 12 }, (_, i) => ({ name: `f${String(i).padStart(2, '0')}.txt`, size: 10 })) };
  const bg = fakeBg();
  bg.zipAddDelay = 30; // начатые файлы ложатся в архив, пока идёт сверка
  bg.zipStateDelay = 60;
  const engine = makeEngine({ source: fakeSource(tree), bg });
  await engine.createJob({ scope: ALL, options: zipOptions({ name: 'Диск' }) });
  const run1 = engine.start();
  while (bg.started.length < 3) await new Promise((r) => setTimeout(r, 1));
  await engine.pause();
  const run2 = engine.start(); // «Продолжить», пока начатые файлы ещё качаются
  await run1;
  await run2;
  while (engine.job.meta.phase === 'running') await new Promise((r) => setTimeout(r, 5));
  assert.equal(engine.snapshot().job.phase, 'done');
  assert.deepEqual(savedPaths(bg), tree['/disk'].map((f) => f.name));
  const perFile = new Map();
  for (const d of bg.started) perFile.set(d.filename, (perFile.get(d.filename) || 0) + 1);
  assert.ok([...perFile.values()].every((n) => n === 1), 'каждый файл скачан один раз: ' + JSON.stringify([...perFile]));
});

// --- Выбор вручную ------------------------------------------------------------------
test('пути для выбранного вручную: общая папка, относительные пути, подпись', () => {
  assert.equal(YDD.commonDir(['/disk/Фото/2019', '/disk/Документы']), '/disk');
  assert.equal(YDD.commonDir(['/disk/Фото', '/disk/Фото']), '/disk/Фото');
  assert.equal(YDD.commonDir(['/disk/Фото/2019', '/disk/Фото/2020']), '/disk/Фото');
  assert.equal(YDD.commonDir(['/', '/Вложенная']), '/');
  assert.equal(YDD.relativeLocal('/disk/Фото/2019', '/disk'), 'Фото/2019');
  assert.equal(YDD.relativeLocal('/disk', '/disk'), '');
  assert.equal(YDD.relativeLocal('/disk/Отчёт: итоги?', '/disk'), 'Отчёт_ итоги_', 'имена приводятся к допустимым');
  assert.equal(YDD.pickSummary(2, 5), '2 папки и 5 файлов');
  assert.equal(YDD.pickSummary(0, 1), '1 файл');
  assert.equal(YDD.pickSummary(1, 0), '1 папка');
});

test('выбрано вручную: папки целиком и отдельные файлы из разных мест', async () => {
  const tree = {
    '/disk': [{ name: 'Фото', type: 'dir' }, { name: 'Документы', type: 'dir' }, { name: 'readme.txt', size: 3 }],
    '/disk/Фото': [{ name: '2019', type: 'dir' }, { name: 'one.jpg', size: 1 }, { name: 'two.jpg', size: 2 }],
    '/disk/Фото/2019': [{ name: 'a.jpg', size: 4 }, { name: 'Вложенная', type: 'dir' }],
    '/disk/Фото/2019/Вложенная': [{ name: 'b.jpg', size: 5 }],
    '/disk/Документы': [{ name: 'x.pdf', size: 6 }, { name: 'y.pdf', size: 7 }],
  };
  const item = (id, size, type = 'file') => ({ id, name: YDD.basename(id), type, size, mediaType: null, mtime: 0, partial: false });
  const pickScope = (base, prefix = '') => {
    const localOf = (p) => YDD.joinPath(prefix, YDD.relativeLocal(p, base));
    return {
      type: 'pick',
      label: 'Выбрано: 1 папка и 2 файла',
      roots: [{ path: '/disk/Фото/2019', local: localOf('/disk/Фото/2019') }],
      files: [item('/disk/Документы/y.pdf', 7), item('/disk/readme.txt', 3)].map((f) => ({ item: f, parentLocal: localOf(YDD.dirname(f.id)) })),
    };
  };

  // На компьютер: те же папки, что на Диске; одна папка целиком, два файла по отдельности.
  const source = fakeSource(tree);
  const bg = fakeBg();
  const engine = makeEngine({ source, bg });
  await engine.createJob({ scope: pickScope('/disk'), options: {} });
  await engine.start();
  assert.equal(engine.snapshot().job.phase, 'done');
  assert.deepEqual(bg.started.map((d) => d.filename).sort(), [
    'Яндекс Диск/readme.txt',
    'Яндекс Диск/Документы/y.pdf',
    'Яндекс Диск/Фото/2019/a.jpg',
    'Яндекс Диск/Фото/2019/Вложенная/b.jpg',
  ]);
  assert.ok(source.calls.list <= 2, 'перебирались только выбранные папки, а не родительские: ' + source.calls.list);

  // В архив: пути от общей папки выбранного.
  const zbg = fakeBg();
  const zengine = makeEngine({ source: fakeSource(tree), bg: zbg });
  await zengine.createJob({ scope: pickScope(YDD.commonDir(['/disk/Фото', '/disk/Документы', '/disk'])), options: zipOptions({ name: 'Яндекс Диск (выбранное)' }) });
  await zengine.start();
  assert.deepEqual(savedPaths(zbg), ['readme.txt', 'Документы/y.pdf', 'Фото/2019/a.jpg', 'Фото/2019/Вложенная/b.jpg']);
});

// --- Типы файлов -------------------------------------------------------------------
test('типы файлов: расширение и группа', () => {
  assert.equal(YDD.fileExt('IMG_0001.JPG'), 'jpg');
  assert.equal(YDD.fileExt('.hidden'), '');
  assert.equal(YDD.fileExt('README'), '');
  assert.equal(YDD.fileExt('архив.tar.gz'), 'gz');
  assert.equal(YDD.fileExt('отчёт 2019 final'), '', 'пробел — не расширение');
  assert.equal(YDD.typeGroup('heic'), 'photo');
  assert.equal(YDD.typeGroup('mov'), 'video');
  assert.equal(YDD.typeGroup('xlsx'), 'docs');
  assert.equal(YDD.typeGroup('xyz', 'audio'), 'audio', 'незнакомое расширение — по типу от Яндекса');
  assert.equal(YDD.typeGroup('xyz'), 'other');
});

test('фильтр типов: сначала поиск, потом скачивание только выбранного, типы можно добавить позже', async () => {
  const tree = {
    '/disk': [{ name: 'Фото', type: 'dir' }, { name: 'Документы', type: 'dir' }, { name: 'README', size: 1 }],
    '/disk/Фото': [
      { name: 'a.JPG', size: 10, mediaType: 'image' },
      { name: 'b.jpg', size: 20, mediaType: 'image' },
      { name: 'c.heic', size: 30, mediaType: 'image' },
      { name: 'clip.mov', size: 400, mediaType: 'video' },
    ],
    '/disk/Документы': [{ name: 'x.pdf', size: 5 }, { name: 'y.docx', size: 6 }, { name: 'z.pdf', size: 7 }],
  };
  const area = memoryArea();
  const bg = fakeBg();
  const engine = makeEngine({ source: fakeSource(tree), bg, area });
  await engine.createJob({ scope: ALL, options: {}, filter: 'ask' });
  await engine.start();
  let s = engine.snapshot();
  assert.equal(s.job.phase, 'paused');
  assert.equal(s.blocked.kind, 'filter', 'ждём выбора типов');
  assert.equal(bg.started.length, 0, 'пока типы не выбраны, ничего не качаем');
  assert.equal(s.found, 8);
  const stats = engine.typeStats();
  const byExt = Object.fromEntries(stats.flatMap((g) => g.exts.map((e) => [e.ext, [g.id, e.count, e.bytes]])));
  assert.deepEqual(byExt, {
    jpg: ['photo', 2, 30],
    heic: ['photo', 1, 30],
    mov: ['video', 1, 400],
    pdf: ['docs', 2, 12],
    docx: ['docs', 1, 6],
    '': ['other', 1, 1],
  });
  assert.deepEqual(stats.map((g) => g.id), ['photo', 'video', 'docs', 'other'], 'группы в постоянном порядке');

  // Страницу перезагрузили, пока ждали выбора, — снова спрашиваем.
  await engine.flush(true);
  const again = makeEngine({ source: fakeSource(tree), bg, area });
  await again.loadCurrent();
  await again.start();
  assert.equal(again.snapshot().blocked.kind, 'filter');
  assert.deepEqual(again.typeStats().map((g) => g.count), [3, 1, 3, 1], 'типы восстановлены из сохранённого задания');

  again.applyFilter(['jpg', 'pdf']);
  await again.start();
  s = again.snapshot();
  assert.equal(s.job.phase, 'done');
  assert.deepEqual(bg.started.map((d) => d.filename).sort(), ['Яндекс Диск/Документы/x.pdf', 'Яндекс Диск/Документы/z.pdf', 'Яндекс Диск/Фото/a.JPG', 'Яндекс Диск/Фото/b.jpg']);
  assert.equal(s.total, 4, 'в счёт идут только выбранные типы');
  assert.equal(s.totalBytes, 42);
  assert.equal(s.excluded, 4);
  assert.equal(s.done, 4);
  assert.ok(!/clip\.mov|README/.test(again.buildReport()), 'отфильтрованные файлы не попадают в отчёт');

  // Докачать ещё и видео в том же задании.
  again.applyFilter(['jpg', 'pdf', 'mov']);
  await again.start();
  s = again.snapshot();
  assert.equal(s.job.phase, 'done');
  assert.equal(s.done, 5);
  assert.equal(bg.started.length, 5, 'скачанное раньше не качается заново');
  assert.ok(bg.started.some((d) => d.filename === 'Яндекс Диск/Фото/clip.mov'));
});

// --- Переводы ---------------------------------------------------------------------
test('переводы: в каждом языке все строки и те же подстановки, что в русском', () => {
  const dir = path.join(SRC, '..', 'locales');
  const vars = (s) => new Set((String(s).match(/\{(\w+)\}/g) || []).sort());
  const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  const forms = (v) => (typeof v === 'object' ? Object.values(v) : [v]);
  // Слово из букв разных алфавитов — почти всегда опечатка: латинская «a» среди кириллицы и т. п.
  const scripts = ['Latin', 'Cyrillic', 'Armenian', 'Georgian'].map((s) => new RegExp(`\\p{Script=${s}}`, 'u'));
  const mixed = (s) => s.split(/[^\p{L}\p{M}]+/u).filter((w) => scripts.filter((re) => re.test(w)).length > 1);
  const codes = YDD.i18n.LANGS.map((l) => l.code);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(files, [...codes].sort(), 'словарь есть у каждого языка из меню и только у них');
  for (const code of codes) {
    const dict = JSON.parse(fs.readFileSync(path.join(dir, code + '.json'), 'utf8'));
    const problems = [];
    for (const key of Object.keys(RU)) {
      if (!(key in dict)) {
        problems.push(`нет ${key}`);
        continue;
      }
      const want = vars(forms(RU[key])[0]);
      for (const form of forms(dict[key])) {
        if (typeof form !== 'string') problems.push(`${key}: не строка`);
        else if (!same(vars(form), want)) problems.push(`${key}: подстановки ${[...vars(form)]} вместо ${[...want]}`);
        else for (const w of mixed(form)) problems.push(`${key}: смешаны алфавиты в «${w}»`);
      }
      if (typeof RU[key] === 'object' && typeof dict[key] === 'object' && !('other' in dict[key])) problems.push(`${key}: нет формы other`);
      if (typeof RU[key] !== typeof dict[key] && typeof dict[key] !== 'string') problems.push(`${key}: другой вид значения`);
    }
    for (const key of Object.keys(dict)) if (!(key in RU)) problems.push(`лишний ${key}`);
    assert.deepEqual(problems, [], code);
  }
  // Числа: почти везде «1 234,5», как по-русски, у азербайджанского — «1.234,5».
  const load = (code) => JSON.parse(fs.readFileSync(path.join(dir, code + '.json'), 'utf8'));
  YDD.i18n.use('kk', load('kk'), RU);
  assert.equal(YDD.formatBytes(20.5 * 1024 * 1024), '20,5 МБ');
  YDD.i18n.use('az', load('az'), RU);
  assert.equal(YDD.formatCount(1234567), '1.234.567');
  YDD.i18n.use('en', load('en'), RU);
  assert.equal(YDD.formatBytes(20.5 * 1024 * 1024), '20.5 MB');
  YDD.i18n.use('ru', RU, RU);
  // Выбор языка и подстановки
  assert.equal(YDD.i18n.detect(['de-DE', 'kk-KZ', 'ru']), 'kk');
  assert.equal(YDD.i18n.detect(['de-DE', 'fr']), 'ru', 'незнакомый язык — русский');
  assert.equal(YDD.t('count.files', { n: 21 }), '21 файл');
  assert.equal(YDD.t('count.files', { n: 1234 }), '1 234 файла'.replace(' ', ' '));
});
