'use strict';
/*
 * Поддельный Яндекс Диск для проверки расширения в настоящем браузере.
 * Отвечает за disk.yandex.ru, *.downloader.disk.yandex.ru, *.storage.yandex.net и cloud-api.yandex.net
 * (браузер направляет эти имена на 127.0.0.1 через --host-resolver-rules).
 * Форматы запросов и ответов повторяют веб-версию Диска (октябрь 2026).
 */
const https = require('node:https');

const SK_PAGE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678:1760900000'; // устаревший sk со страницы
const SK_VALID = 'ffeeddccbbaa99887766554433221100ffeeddcc:1760909999'; // актуальный — выдаётся через CKEY
const UID = '424242';
const CONNECTION_ID = 'conntest1234567890abcd';
const SESSION = 'Session_id=test-session';
const PUBLIC_HASH = 'PUBHASH42';

function hash(s) {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193);
  return h >>> 0;
}

/**
 * Очень большой файл (opts.huge — размер в байтах) отдаётся потоком: строка с путём повторяется
 * до нужного размера, целиком в памяти файл не держится.
 */
function hugeBlock(path) {
  const line = Buffer.from(`YDD test file ${path}\n`);
  const block = Buffer.alloc(line.length * Math.floor((1 << 20) / line.length));
  for (let i = 0; i < block.length; i += line.length) line.copy(block, i);
  return block;
}

function streamHuge(res, path, total) {
  const block = hugeBlock(path);
  let sent = 0;
  const pump = () => {
    while (sent < total) {
      const piece = block.subarray(0, Math.min(block.length, total - sent));
      sent += piece.length;
      if (!res.write(piece)) return res.once('drain', pump);
    }
    res.end();
  };
  res.on('close', () => (sent = total));
  pump();
}

/** Содержимое файла однозначно определяется путём — так проверяем, что сохранилось именно оно. */
function content(path) {
  const node = NODES.get(path);
  const line = Buffer.from(`YDD test file ${path}\n`);
  if (node && node.opts && node.opts.bytes) {
    // Большой файл заданного размера — для проверки переноса по частям.
    const out = Buffer.alloc(node.opts.bytes);
    for (let i = 0; i < out.length; i += line.length) line.copy(out, i);
    return out;
  }
  return Buffer.from(line.toString().repeat(5 + (hash(path) % 300)));
}

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(200, 7),
  Buffer.from([0xff, 0xd9]),
]);

// --- Дерево Диска ------------------------------------------------------------------
let FILE_LIST = [
  ['/disk/readme.txt'],
  ['/disk/.hidden'],
  ['/disk/CON.txt'],
  ['/disk/Отчёт: итоги?.txt'],
  ['/disk/копия~1.txt'],
  ...Array.from({ length: 45 }, (_, i) => [`/disk/Фото/IMG_${String(i).padStart(3, '0')}.jpg`, { mediatype: 'image' }]),
  ['/disk/Фото/dead.jpg', { mediatype: 'image', dead: true }],
  ['/disk/Фото/2019/A.JPG', { mediatype: 'image' }],
  ['/disk/Фото/2019/a.jpg', { mediatype: 'image' }],
  ['/disk/Документы/flaky.pdf', { flaky: true }],
  ['/disk/Документы/gone.docx', { gone: true }],
  ['/disk/Документы/dead.mp4', { mediatype: 'video', dead: true }],
  ['/disk/Документы/Глубоко/Ещё глубже/файл.txt'],
  ['/disk/Медленно/slow.bin', { slow: true }],
  ['/disk/Медленно/fast.txt'],
  ['/disk/Видео/Отпуск 2019.mov', { mediatype: 'video', bytes: 20 * 1024 * 1024 }],
  // Восемь «мёртвых» файлов подряд в самом начале обхода (папка идёт первой по алфавиту):
  // сервер принимает соединение и молчит 40 секунд. Без проверки ссылок они заняли бы
  // все 6 соединений браузера с сервером, и следующий файл уже не скачался бы.
  ...Array.from({ length: 8 }, (_, i) => [`/disk/Аварийные/dead-${i + 1}.bin`, { deadFor: 40000 }]),
  ['/disk/Аварийные/после.txt'],
];
let EMPTY_DIRS = ['/disk/Пустая папка'];
let UNLIM = Array.from({ length: 5 }, (_, i) => `/photounlim/2018-01-0${i + 1} 10-00-00.JPG`);
let CLUSTERS = [
  { id: '0000001514800000000_0000001514900000000', items: ['/disk/Фото/IMG_000.jpg', UNLIM[0], UNLIM[1]] },
  { id: '0000001515000000000_0000001515100000000', items: ['/disk/Фото/IMG_001.jpg'] },
  { id: '0000001515200000000_0000001515300000000', items: [UNLIM[2], UNLIM[3], UNLIM[4], '/disk/Фото/IMG_002.jpg'] },
];

const NODES = new Map(); // путь → {type, opts}
function addNode(path, node) {
  NODES.set(path, node);
  const parent = path.slice(0, path.lastIndexOf('/')) || '/';
  if (parent !== '/' && !NODES.has(parent)) addNode(parent, { type: 'dir' });
}
// Настройки поддельного Диска. По умолчанию — дерево для автотестов; для скриншотов сайта его подменяют.
let OPTIONS = { rateLimit: true, space: null, selection: { '/disk/Фото': [['2019', 'dir', true], ['IMG_001.jpg', 'file', true], ['IMG_002.jpg', 'file', false]] } };

function buildTree() {
  NODES.clear();
  NODES.set('/disk', { type: 'dir' });
  for (const [path, opts] of FILE_LIST) addNode(path, { type: 'file', opts: opts || {} });
  for (const path of EMPTY_DIRS) addNode(path, { type: 'dir' });
  for (const path of UNLIM) NODES.set(path, { type: 'file', opts: { mediatype: 'image', size: OPTIONS.unlimSize || 0 } });
}
buildTree();

/** Подменяет дерево и поведение (используется скриптом скриншотов). */
function configure(cfg) {
  if (cfg.files) FILE_LIST = cfg.files;
  if (cfg.emptyDirs) EMPTY_DIRS = cfg.emptyDirs;
  if (cfg.unlim) UNLIM = cfg.unlim;
  if (cfg.clusters) CLUSTERS = cfg.clusters;
  OPTIONS = Object.assign({}, OPTIONS, cfg.options || {});
  buildTree();
}

const name = (p) => p.slice(p.lastIndexOf('/') + 1);
const enc = encodeURIComponent;
const tok = (p) => hash(p).toString(16).padStart(8, '0').repeat(8);
const expiry = () => Math.floor(Date.now() / 1000 + 3600).toString(16);

/** Дата изменения файла (секунды): у каждого своя — проверяем, что она попадает в архив. */
const mtimeOf = (path) => 1500000000 + (hash(path) % 200000000);

function resource(path) {
  const node = NODES.get(path);
  const mtime = mtimeOf(path);
  if (node.type === 'dir') return { id: path, name: name(path), type: 'dir', mtime, ctime: mtime, meta: { files_count: 0 } };
  const opts = node.opts;
  const meta = { size: opts.size || opts.huge || content(path).length, mediatype: opts.mediatype || 'document', resource_id: UID + ':' + tok(path) };
  if (path.startsWith('/photounlim/')) meta.storage_type = 'photounlim';
  if (opts.mediatype === 'image') {
    meta.sizes = [
      { name: 'ORIGINAL', url: `//downloader.disk.yandex.ru/disk/${tok(path)}/${expiry()}/orig?path=${enc(path)}&disposition=inline` },
      { name: 'DEFAULT', url: `//1.downloader.disk.yandex.ru/preview/${tok(path)}/inf/d?path=${enc(path)}&size=S` },
      { name: 'XXXL', url: `//2.downloader.disk.yandex.ru/preview/${tok(path)}/inf/x?path=${enc(path)}&size=XXXL` },
    ];
  }
  return { id: path, name: name(path), type: 'file', mtime, ctime: mtime, meta };
}

function children(dir) {
  const out = [];
  for (const path of NODES.keys()) {
    if (path.startsWith('/photounlim/')) continue;
    if (path.slice(0, path.lastIndexOf('/')) === dir) out.push(path);
  }
  return out.sort();
}

// --- Публичная ссылка --------------------------------------------------------------
const PUBLIC_KEY = `https://disk.yandex.ru/d/${PUBLIC_HASH}`;
const PUBLIC_TREE = {
  '/': { type: 'dir', name: 'Общая папка', items: ['/x.txt', '/Вложенная'] },
  '/x.txt': { type: 'file', name: 'x.txt' },
  '/Вложенная': { type: 'dir', name: 'Вложенная', items: ['/Вложенная/y.jpg'] },
  '/Вложенная/y.jpg': { type: 'file', name: 'y.jpg', media_type: 'image' },
};
function publicResource(path) {
  const n = PUBLIC_TREE[path];
  const r = { type: n.type, name: n.name, path, public_key: PUBLIC_KEY };
  if (n.type === 'file') Object.assign(r, { size: content('pub:' + path).length, media_type: n.media_type || 'document' });
  return r;
}

// --- Облака для проверки переноса ---------------------------------------------------
const DAV_HOST = 'dav.example.test';
const DAV_AUTH = 'Basic ' + Buffer.from('tester:секрет-123').toString('base64');
const S3_HOST = 's3.example.test';
const S3_CREDS = { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' };

// --- Сервер ----------------------------------------------------------------------------
function startMock({ key, cert, s3Port, aws4 }) {
  const state = {
    dav: new Map(), // путь → содержимое
    davDirs: new Set(['/remote.php/dav/files/tester']),
    davLog: [],
    s3Log: [],
    s3SignatureErrors: [],
    api: [],
    resourcesCalls: 0,
    ckeyIssued: 0,
    rateLimited: 0,
    downloads: {},
    requests: {},
    probes: {},
    previews: {},
    previewAccept: [],
    cookieMissing: 0,
    badParams: [],
    held: new Set(),
  };

  const send = (res, status, body, headers = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, Object.assign({ 'Content-Length': buf.length }, headers));
    res.end(buf);
  };
  const json = (res, status, body, headers = {}) => send(res, status, body, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers));
  const hasSession = (req) => (req.headers.cookie || '').includes(SESSION);
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

  function clientPage(diskPath) {
    const data = {
      config: { sk: SK_PAGE, idClient: CONNECTION_ID, domain: 'ru', tld: 'ru' },
      userCurrent: { id: UID, uid: UID, login: 'tester', connection_id: CONNECTION_ID },
      space: OPTIONS.space || { files_count: FILE_LIST.length, used: 10 * 1024 * 1024, trash: 0, photounlim: 777 },
      environment: { session: { experiment: { disk_web_no_archive_download: true } } },
    };
    const row = (n, type, selected) =>
      `<div class="listing-item listing-item_theme_tile listing-item_type_${type}" aria-selected="${selected}" role="row"><div class="listing-item__info"><div class="listing-item__title" aria-label="${n}"><span>${n}</span></div></div></div>`;
    const rows = (OPTIONS.selection[diskPath] || []).map(([n, type, selected]) => row(n, type, selected)).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Файлы — Яндекс Диск</title></head>
<body style="background:#fff;margin:0"><div class="root"><div class="listing"><div class="listing__items">${rows}</div></div></div>
<script id="preloaded-data" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script></body></html>`;
  }

  async function handleModels(req, res, url) {
    const method = url.searchParams.get('m');
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return json(res, 400, { error: { code: 'BAD_JSON' } });
    }
    state.api.push({ method, params: body.requestParams, sk: body.sk });
    if (!hasSession(req)) return json(res, 401, { error: { code: 'NO_AUTH' } });
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest' || !/^application\/json/.test(req.headers['content-type'] || '')) {
      state.badParams.push('headers');
      return json(res, 400, { error: { code: 'BAD_HEADERS' } });
    }
    if (body.apiMethod !== method || body.connection_id !== CONNECTION_ID) {
      state.badParams.push('body');
      return json(res, 400, { error: { code: 'BAD_REQUEST' } });
    }
    if (body.sk !== SK_VALID) {
      state.ckeyIssued++;
      return json(res, 400, { error: { code: 'CKEY', ckey: SK_VALID, uid: UID } });
    }
    const p = body.requestParams || {};
    switch (method) {
      case 'mpfs/resources': {
        if (++state.resourcesCalls === 3 && OPTIONS.rateLimit) {
          state.rateLimited++;
          return json(res, 429, { error: { code: 'TOO_MANY_REQUESTS' } }, { 'Retry-After': '1' });
        }
        if (p.sort !== 'name' || p.order !== '1' || p.amount !== 40) state.badParams.push('resources:' + JSON.stringify(p));
        if (!NODES.has(p.idContext)) return json(res, 404, { error: { code: 'HTTP_404' } });
        const list = children(p.idContext);
        const page = list.slice(p.offset || 0, (p.offset || 0) + p.amount).map(resource);
        return json(res, 200, { resources: page });
      }
      case 'mpfs/url': {
        const node = NODES.get(p.path);
        if (!node || (node.opts && node.opts.gone)) return json(res, 404, { error: { code: 'HTTP_404', title: 'Resource not found' } });
        return json(res, 200, {
          file: `//downloader.disk.yandex.ru/disk/${tok(p.path)}/${expiry()}/x?path=${enc(p.path)}&disposition=attachment&filename=${enc(name(p.path))}`,
        });
      }
      case 'mpfs/info': {
        if (!NODES.has(p.path)) return json(res, 404, { error: { code: 'HTTP_404' } });
        return json(res, 200, resource(p.path));
      }
      case 'intapi/photo-init-snapshot':
        return json(res, 200, { photoslice_id: 'ps-test-1', revision: 5 });
      case 'intapi/photo-get-snapshot':
        if (p.id !== 'ps-test-1') return json(res, 400, { error: { code: 'BAD_SNAPSHOT' } });
        return json(res, 200, {
          id: 'ps-test-1',
          items: CLUSTERS.map((c) => ({
            id: c.id,
            size: c.items.length,
            albums: { photounlim: c.items.filter((i) => i.startsWith('/photounlim/')).length, camera: c.items.length },
          })),
        });
      case 'intapi/photo-get-clusters-with-resources': {
        const fetched = [];
        const resources = [];
        for (const [cid, { range }] of Object.entries(p.clusters || {})) {
          const c = CLUSTERS.find((x) => x.id === cid);
          if (!c) continue;
          // Как у настоящего сервера: в items — весь индекс кластера, в resources — только диапазон.
          fetched.push({ id: cid, items: c.items.map((id) => ({ id, width: 100, height: 100 })) });
          for (const id of c.items.slice(range[0], range[1] + 1)) resources.push(resource(id));
        }
        return json(res, 200, { clusters: { fetched, missing: [] }, resources });
      }
      default:
        return json(res, 400, { error: { code: 'UNKNOWN_METHOD' } });
    }
  }

  function handleDownloader(req, res, url) {
    const path = url.searchParams.get('path') || '';
    if (url.pathname.startsWith('/preview/')) {
      if (!hasSession(req)) return send(res, 403, 'forbidden');
      state.previews[path] = (state.previews[path] || 0) + 1;
      state.previewAccept.push(req.headers.accept || '');
      return send(res, 200, JPEG, { 'Content-Type': 'image/jpeg' });
    }
    if (!url.pathname.startsWith('/disk/')) return send(res, 404, 'not found');
    const isPublic = path.startsWith('pub:');
    if (!isPublic && !hasSession(req)) {
      state.cookieMissing++;
      return send(res, 403, 'no cookie');
    }
    // Проверка ссылки расширением (1 байт) — отдельно от настоящего скачивания.
    const isProbe = req.headers.range === 'bytes=0-0';
    state.requests[path] = (state.requests[path] || 0) + 1;
    if (isProbe) state.probes[path] = (state.probes[path] || 0) + 1;
    else state.downloads[path] = (state.downloads[path] || 0) + 1;
    const node = NODES.get(path);
    if (node && (node.opts.dead || node.opts.deadFor)) {
      // Узел хранения не отвечает: соединение висит без ответа (deadFor — потом обрывается).
      state.held.add(res);
      res.on('close', () => state.held.delete(res));
      if (node.opts.deadFor) setTimeout(() => res.destroy(), node.opts.deadFor);
      return;
    }
    if (node && node.opts.flaky && state.requests[path] === 1) return send(res, 500, 'Internal Server Error');
    const storage = `https://s${hash(path) % 900 + 100}klg.storage.yandex.net/rdisk/${tok(path)}?path=${enc(path)}`;
    res.writeHead(302, { Location: storage, 'Content-Length': 0 });
    res.end();
  }

  function handleStorage(req, res, url) {
    const path = url.searchParams.get('path') || '';
    const node = NODES.get(path);
    if (node && node.opts.huge) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': node.opts.huge });
      return streamHuge(res, path, node.opts.huge);
    }
    const body = content(path);
    if (req.headers.range === 'bytes=0-0') {
      return send(res, 206, body.subarray(0, 1), { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 0-0/${body.length}` });
    }
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${enc(name(path))}`,
    };
    if (node && node.opts.slow) {
      // Отдаём медленно, чтобы успеть перезагрузить страницу посреди скачивания.
      res.writeHead(200, headers);
      let pos = 0;
      const step = Math.ceil(body.length / 20);
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer);
        res.write(body.subarray(pos, pos + step));
        pos += step;
        if (pos >= body.length) {
          clearInterval(timer);
          res.end();
        }
      }, 400);
      return;
    }
    send(res, 200, body, headers);
  }

  function handleCloudApi(req, res, url) {
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return send(res, 204, '', cors);
    if (url.searchParams.get('public_key') !== PUBLIC_KEY) return json(res, 404, { error: 'DiskNotFoundError' }, cors);
    const path = url.searchParams.get('path') || '/';
    const node = PUBLIC_TREE[path];
    if (!node) return json(res, 404, { error: 'DiskNotFoundError' }, cors);
    if (url.pathname === '/v1/disk/public/resources/download') {
      return json(res, 200, { href: `https://downloader.disk.yandex.ru/disk/pub/${expiry()}/x?path=${enc('pub:' + path)}`, method: 'GET', templated: false }, cors);
    }
    if (url.pathname !== '/v1/disk/public/resources') return json(res, 404, { error: 'NotFound' }, cors);
    const r = publicResource(path);
    if (node.type === 'dir') {
      const limit = Number(url.searchParams.get('limit') || 20);
      const offset = Number(url.searchParams.get('offset') || 0);
      r._embedded = { items: node.items.slice(offset, offset + limit).map(publicResource), total: node.items.length, limit, offset, path };
    }
    return json(res, 200, r, cors);
  }

  function handleStoragePublic(req, res, url) {
    return handleStorage(req, res, url);
  }

  /** Простой WebDAV-сервер в памяти: MKCOL, PUT, PROPFIND, DELETE, Basic-авторизация. */
  async function handleDav(req, res, url) {
    const raw = [];
    for await (const c of req) raw.push(c);
    const body = Buffer.concat(raw);
    const p = decodeURIComponent(url.pathname).replace(/\/$/, '');
    state.davLog.push(`${req.method} ${p}`);
    if (req.headers.authorization !== DAV_AUTH) return send(res, 401, 'unauthorized', { 'WWW-Authenticate': 'Basic realm="dav"' });
    const parent = p.slice(0, p.lastIndexOf('/'));
    switch (req.method) {
      case 'PROPFIND':
        return send(res, state.davDirs.has(p) || state.dav.has(p) ? 207 : 404, '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
      case 'MKCOL':
        if (state.davDirs.has(p)) return send(res, 405, 'exists');
        if (!state.davDirs.has(parent)) return send(res, 409, 'no parent');
        state.davDirs.add(p);
        return send(res, 201, '');
      case 'PUT':
        if (!state.davDirs.has(parent)) return send(res, 409, 'no parent');
        state.dav.set(p, body);
        return send(res, 201, '');
      case 'DELETE':
        state.dav.delete(p);
        return send(res, 204, '');
      default:
        return send(res, 405, 'method');
    }
  }

  /**
   * S3: запросы уходят в s3rver, но сначала подпись независимо пересчитывается библиотекой aws4.
   * (s3rver сам подписи v4 не проверяет.)
   */
  function handleS3(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const auth = req.headers.authorization || '';
      const m = /Credential=[^/]+\/\d{8}\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})/.exec(auth);
      state.s3Log.push(`${req.method} ${req.url}`);
      if (!m) {
        state.s3SignatureErrors.push('no auth: ' + req.url);
        return send(res, 403, '<Error><Code>AccessDenied</Code></Error>');
      }
      const headers = {};
      for (const name of m[2].split(';')) if (name !== 'host') headers[name] = req.headers[name];
      const opts = { host: req.headers.host, path: req.url, method: req.method, service: 's3', region: m[1], headers };
      aws4.sign(opts, S3_CREDS);
      const expected = /Signature=([0-9a-f]{64})/.exec(opts.headers.Authorization)[1];
      if (expected !== m[3]) {
        state.s3SignatureErrors.push(`${req.method} ${req.url}`);
        return send(res, 403, '<Error><Code>SignatureDoesNotMatch</Code></Error>');
      }
      const upstream = require('node:http').request(
        { host: '127.0.0.1', port: s3Port, method: req.method, path: req.url, headers: Object.assign({}, req.headers, { 'content-length': body.length }) },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        }
      );
      upstream.on('error', (e) => send(res, 502, String(e)));
      upstream.end(body);
    });
  }

  const server = https.createServer({ key, cert }, async (req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    const url = new URL(req.url, `https://${host}`);
    try {
      if (host === 'disk.yandex.ru') {
        if (req.method === 'POST' && url.pathname === '/models-v2') return await handleModels(req, res, url);
        if (url.pathname === '/client/disk' || url.pathname.startsWith('/client/disk/')) {
          const rest = url.pathname.slice('/client/disk'.length).split('/').filter(Boolean).map(decodeURIComponent);
          return send(res, 200, clientPage('/disk' + (rest.length ? '/' + rest.join('/') : '')), {
            'Content-Type': 'text/html; charset=utf-8',
            'Set-Cookie': `${SESSION}; Domain=.yandex.ru; Path=/; Secure; HttpOnly; SameSite=None`,
          });
        }
        if (url.pathname === `/d/${PUBLIC_HASH}` || url.pathname.startsWith(`/d/${PUBLIC_HASH}/`)) {
          return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Общая папка — Яндекс Диск</title></head><body style="background:#fff"></body></html>`, {
            'Content-Type': 'text/html; charset=utf-8',
          });
        }
        return send(res, 404, 'not found');
      }
      if (/^(\d+\.)?downloader\.disk\.yandex\.ru$/.test(host)) return handleDownloader(req, res, url);
      if (/\.storage\.yandex\.net$/.test(host)) return handleStoragePublic(req, res, url);
      if (host === 'cloud-api.yandex.net') return handleCloudApi(req, res, url);
      if (host === DAV_HOST) return await handleDav(req, res, url);
      if (host === S3_HOST && s3Port) return handleS3(req, res);
      return send(res, 404, 'unknown host ' + host);
    } catch (e) {
      console.error('mock error', e);
      if (!res.headersSent) send(res, 500, String(e));
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        close: () =>
          new Promise((r) => {
            for (const res of state.held) res.destroy();
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

module.exports = { startMock, configure, content, hugeBlock, mtimeOf, FILE_LIST, UNLIM, PUBLIC_TREE, PUBLIC_HASH, NODES, JPEG, DAV_HOST, S3_HOST };
