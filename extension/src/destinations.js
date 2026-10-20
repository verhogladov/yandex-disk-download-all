/*
 * Куда переносить файлы, если не на этот компьютер: WebDAV (свой сервер, Nextcloud, NAS…)
 * или S3-совместимое хранилище. Используется страницей настроек и offscreen-документом,
 * который переносит файлы; в тестах — из Node.
 */
(function (root) {
  'use strict';
  const YDD = (root.YDD = root.YDD || {});

  class DestError extends Error {
    constructor(code, message, status) {
      super(message);
      this.name = 'DestError';
      this.code = code; // DEST_AUTH | DEST_CONFIG | DEST_FULL | DEST_TOO_LARGE | DEST_FAILED | DEST_NETWORK | USER_CANCELED
      this.status = status || 0;
    }
  }

  const textEncoder = new TextEncoder();
  const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

  async function sha256Hex(data) {
    return toHex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? textEncoder.encode(data) : data));
  }

  async function hmac(key, data) {
    const raw = typeof key === 'string' ? textEncoder.encode(key) : key;
    const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', k, textEncoder.encode(data));
  }

  /** Кодирование по RFC 3986, как требует подпись AWS: всё, кроме A–Z a–z 0–9 - _ . ~ */
  function uriEncode(str, keepSlash = false) {
    let out = '';
    for (const byte of textEncoder.encode(String(str))) {
      const ch = String.fromCharCode(byte);
      if ((byte < 0x80 && /[A-Za-z0-9\-_.~]/.test(ch)) || (keepSlash && ch === '/')) out += ch;
      else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  }

  function amzDateOf(date) {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  }

  /**
   * Подпись AWS Signature Version 4 для заголовков запроса.
   * url уже должен быть закодирован (путь — через uriEncode по сегментам).
   */
  async function signV4({ method, url, headers = {}, payloadHash, accessKeyId, secretAccessKey, region, service = 's3', date = new Date() }) {
    const u = new URL(url);
    const amzDate = headers['x-amz-date'] || amzDateOf(date);
    const dateStamp = amzDate.slice(0, 8);
    const all = Object.assign({ host: u.host }, headers, { 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash });
    const lower = {};
    for (const [k, v] of Object.entries(all)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
    const names = Object.keys(lower).sort();
    const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
    const signedHeaders = names.join(';');
    const query = [...u.searchParams]
      .map(([k, v]) => [uriEncode(k), uriEncode(v)])
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const canonicalRequest = [method, u.pathname, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
    const kDate = await hmac('AWS4' + secretAccessKey, dateStamp);
    const kRegion = await hmac(kDate, region);
    const kService = await hmac(kRegion, service);
    const kSigning = await hmac(kService, 'aws4_request');
    const signature = toHex(await hmac(kSigning, stringToSign));
    return {
      amzDate,
      signature,
      canonicalRequest,
      stringToSign,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  function basicAuth(user, pass) {
    const bytes = textEncoder.encode(`${user}:${pass}`);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return 'Basic ' + btoa(bin);
  }

  // Тексты ошибок: на странице настроек и в offscreen-документе подключены переводы.
  const t = (key, vars) => (YDD.t ? YDD.t(key, vars) : key);

  function abortError() {
    return new DestError('USER_CANCELED', t('dest.err.canceled'));
  }

  // Не меньше 64 КБ/с: столько ждём отправку большого тела запроса, прежде чем считать её зависшей.
  const MIN_UPLOAD_RATE = 64 * 1024;

  /**
   * HTTP-запрос через fetch с credentials: 'omit'. XMLHttpRequest не подходит: на ответ 401
   * браузер показывает своё окно логина, а в невидимом offscreen-документе перенос просто зависает.
   * timeoutMs — общий предел на запрос.
   */
  async function httpRequest({ method, url, headers = {}, body = null, signal, timeoutMs = 120000 }) {
    if (signal && signal.aborted) throw abortError();
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
      const text = await res.text();
      return { status: res.status, headers: res.headers, text: async () => text };
    } catch (e) {
      if (signal && signal.aborted) throw abortError();
      if (timedOut) throw new DestError('DEST_NETWORK', t('dest.err.timeout'));
      throw new DestError('DEST_NETWORK', t('dest.err.offline', { error: e && e.message }));
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  function uploadTimeout(bytes) {
    return Math.max(5 * 60 * 1000, Math.ceil((bytes / MIN_UPLOAD_RATE) * 1000));
  }

  function httpError(status, what, details = '') {
    const tail = details ? `: ${details}` : '';
    if (status === 401 || status === 403) return new DestError('DEST_AUTH', t('dest.err.noAccess', { what, status }) + tail, status);
    if (status === 507) return new DestError('DEST_FULL', t('dest.err.full', { what }), status);
    if (status === 413) return new DestError('DEST_TOO_LARGE', t('dest.err.tooLarge', { what }), status);
    return new DestError('DEST_FAILED', t('dest.err.server', { what, status }) + tail, status);
  }

  /** Собирает поток в Blob частями по 8 МБ, чтобы большие файлы не держать целиком в памяти скрипта. */
  async function collectBlob(source, type = 'application/octet-stream') {
    const parts = [];
    let pending = [];
    let size = 0;
    for await (const chunk of source.chunks()) {
      pending.push(chunk);
      size += chunk.byteLength;
      if (size >= 8 << 20) {
        parts.push(new Blob(pending));
        pending = [];
        size = 0;
      }
    }
    if (pending.length) parts.push(new Blob(pending));
    return new Blob(parts, { type });
  }

  function joinKey(...parts) {
    return parts
      .map((p) => String(p || '').replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .join('/');
  }

  // --- WebDAV ---------------------------------------------------------------------
  class WebDavDestination {
    constructor(cfg) {
      this.type = 'webdav';
      this.cfg = cfg;
      this.base = String(cfg.url || '').trim().replace(/\/+$/, '');
      this.auth = cfg.username ? basicAuth(cfg.username, cfg.password || '') : null;
      this.dirs = new Set();
      const u = new URL(this.base);
      if (!/^https?:$/.test(u.protocol)) throw new DestError('DEST_CONFIG', t('dest.err.davUrl'));
    }

    get origin() {
      return new URL(this.base).origin;
    }

    describe() {
      return 'WebDAV · ' + new URL(this.base).host;
    }

    url(path, dir = false) {
      const encoded = String(path)
        .split('/')
        .filter(Boolean)
        .map((s) => encodeURIComponent(s))
        .join('/');
      return this.base + (encoded ? '/' + encoded : '') + (dir ? '/' : '');
    }

    headers(extra) {
      return Object.assign({}, this.auth ? { Authorization: this.auth } : {}, extra);
    }

    async ensureDir(dir, signal) {
      let current = '';
      for (const part of String(dir).split('/').filter(Boolean)) {
        current = current ? current + '/' + part : part;
        if (this.dirs.has(current)) continue;
        const res = await httpRequest({ method: 'MKCOL', url: this.url(current, true), headers: this.headers(), signal });
        // 201 — создана, 405 — уже есть (так отвечают Nextcloud, Apache и др.)
        if ((res.status >= 200 && res.status < 300) || res.status === 405 || res.status === 301 || res.status === 302) {
          this.dirs.add(current);
          continue;
        }
        throw httpError(res.status, t('dest.err.mkdir', { name: current }));
      }
    }

    async upload(path, source, { onProgress = () => {}, onBusy = () => {}, signal } = {}) {
      const dir = String(path).split('/').slice(0, -1).join('/');
      if (dir) await this.ensureDir(dir, signal);
      const blob = await collectBlob(source);
      const put = async () => {
        onBusy(true);
        try {
          return await httpRequest({
            method: 'PUT',
            url: this.url(path),
            headers: this.headers({ 'Content-Type': 'application/octet-stream' }),
            body: blob,
            signal,
            timeoutMs: uploadTimeout(blob.size),
          });
        } finally {
          onBusy(false);
        }
      };
      let res = await put();
      if (res.status === 409 && dir) {
        // Папку удалили, пока шёл перенос, — создаём заново и повторяем.
        this.dirs.clear();
        await this.ensureDir(dir, signal);
        res = await put();
      }
      if (!(res.status >= 200 && res.status < 300)) throw httpError(res.status, t('dest.err.notAccepted'));
      onProgress(blob.size);
      return { size: blob.size };
    }

    /** Проверка: папка доступна, в неё можно записать и удалить пробный файл. */
    async test() {
      let res = await httpRequest({ method: 'PROPFIND', url: this.base + '/', headers: this.headers({ Depth: '0' }) });
      if (res.status === 404) {
        res = await httpRequest({ method: 'MKCOL', url: this.base + '/', headers: this.headers() });
        if (!(res.status >= 200 && res.status < 300)) throw httpError(res.status, t('dest.err.noFolder'));
      } else if (res.status === 401 || res.status === 403) {
        throw httpError(res.status, t('dest.err.login'));
      } else if (!(res.status >= 200 && res.status < 300)) {
        throw httpError(res.status, t('dest.err.notDav'));
      }
      const probe = `.ydd-test-${Date.now()}.txt`;
      res = await httpRequest({ method: 'PUT', url: this.url(probe), headers: this.headers({ 'Content-Type': 'text/plain' }), body: 'ok' });
      if (!(res.status >= 200 && res.status < 300)) throw httpError(res.status, t('dest.err.probe'));
      await httpRequest({ method: 'DELETE', url: this.url(probe), headers: this.headers() }).catch(() => {});
      return true;
    }
  }

  // --- S3 ---------------------------------------------------------------------------
  const MiB = 1024 * 1024;

  function xmlValue(xml, tag) {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml || '');
    return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'") : '';
  }

  function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function s3Error(status, body, what) {
    const code = xmlValue(body, 'Code');
    const message = xmlValue(body, 'Message');
    const details = [code, message].filter(Boolean).join(': ');
    if (/^(AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId|InvalidToken|ExpiredToken|AuthorizationHeaderMalformed)$/.test(code)) {
      return new DestError('DEST_AUTH', t('dest.err.s3Keys', { what, details }), status);
    }
    if (/^(NoSuchBucket|PermanentRedirect|InvalidBucketName)$/.test(code)) {
      return new DestError('DEST_CONFIG', t('dest.err.s3Config', { what, details }), status);
    }
    if (/Quota|InsufficientStorage/i.test(code) || status === 507) {
      return new DestError('DEST_FULL', t('dest.err.s3Full', { what, details: details || 'HTTP ' + status }), status);
    }
    if (code === 'EntityTooLarge') return new DestError('DEST_TOO_LARGE', t('dest.err.s3TooLarge', { what }), status);
    if (status === 401 || status === 403) return new DestError('DEST_AUTH', t('dest.err.noAccess', { what, status }), status);
    return new DestError('DEST_FAILED', t('dest.err.s3Error', { what, details: details || 'HTTP ' + status }), status);
  }

  class S3Destination {
    constructor(cfg) {
      this.type = 's3';
      this.cfg = cfg;
      this.endpoint = new URL(String(cfg.endpoint || '').trim());
      if (!/^https?:$/.test(this.endpoint.protocol)) throw new DestError('DEST_CONFIG', t('dest.err.s3Url'));
      this.bucket = String(cfg.bucket || '').trim();
      if (!this.bucket) throw new DestError('DEST_CONFIG', t('dest.err.noBucket'));
      this.region = String(cfg.region || '').trim() || 'us-east-1';
      this.prefix = joinKey(cfg.prefix);
      this.pathStyle = cfg.pathStyle !== false;
      // Части по 8 МБ: отправка каждой укладывается в разумный срок даже на медленном канале.
      this.partSize = Math.max(5 * MiB, Number(cfg.partSizeMB) * MiB || 8 * MiB);
    }

    get origin() {
      return this.pathStyle ? this.endpoint.origin : `${this.endpoint.protocol}//${this.bucket}.${this.endpoint.host}`;
    }

    describe() {
      return `S3 · ${this.bucket}`;
    }

    objectUrl(key, query = '') {
      const encodedKey = String(key)
        .split('/')
        .map((s) => uriEncode(s))
        .join('/');
      const base = this.pathStyle ? `${this.endpoint.origin}/${uriEncode(this.bucket)}` : this.origin;
      return `${base}/${encodedKey}${query}`;
    }

    async request(method, url, { headers = {}, body = null, signal, what = t('dest.err.storage'), timeoutMs } = {}) {
      const signed = await signV4({
        method,
        url,
        headers: {},
        payloadHash: 'UNSIGNED-PAYLOAD',
        accessKeyId: this.cfg.accessKeyId,
        secretAccessKey: this.cfg.secretAccessKey,
        region: this.region,
      });
      const all = Object.assign({}, headers, {
        'x-amz-date': signed.amzDate,
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        Authorization: signed.authorization,
      });
      const res = await httpRequest({ method, url, headers: all, body, signal, timeoutMs });
      if (res.status >= 200 && res.status < 300) return res;
      throw s3Error(res.status, await res.text().catch(() => ''), what);
    }

    partSizeFor(size) {
      // Не больше 10 000 частей на файл.
      return size ? Math.max(this.partSize, Math.ceil(size / 9000 / MiB) * MiB) : this.partSize;
    }

    async upload(path, source, { onProgress = () => {}, onBusy = () => {}, signal } = {}) {
      const key = joinKey(this.prefix, path);
      const busy = async (fn) => {
        onBusy(true);
        try {
          return await fn();
        } finally {
          onBusy(false);
        }
      };
      const partSize = this.partSizeFor(source.size);
      let pending = [];
      let buffered = 0;
      let uploadId = null;
      const parts = [];
      let done = 0;
      const sendPart = async (blob) => {
        const n = parts.length + 1;
        const res = await busy(() =>
          this.request('PUT', this.objectUrl(key, `?partNumber=${n}&uploadId=${uriEncode(uploadId)}`), {
            body: blob,
            signal,
            what: t('dest.err.partRejected'),
            timeoutMs: uploadTimeout(blob.size),
          })
        );
        const etag = res.headers.get('ETag');
        if (!etag) throw new DestError('DEST_FAILED', t('dest.err.noEtag'));
        parts.push({ n, etag });
        done += blob.size;
        onProgress(done);
      };
      try {
        for await (const chunk of source.chunks()) {
          pending.push(chunk);
          buffered += chunk.byteLength;
          if (buffered >= partSize) {
            if (!uploadId) {
              const res = await this.request('POST', this.objectUrl(key, '?uploads'), { signal, what: t('dest.err.noStart') });
              uploadId = xmlValue(await res.text(), 'UploadId');
              if (!uploadId) throw new DestError('DEST_FAILED', t('dest.err.noUploadId'));
            }
            const blob = new Blob(pending);
            pending = [];
            buffered = 0;
            await sendPart(blob);
          }
        }
        const rest = new Blob(pending);
        if (!uploadId) {
          // Файл меньше одной части — обычная загрузка одним запросом.
          await busy(() =>
            this.request('PUT', this.objectUrl(key), {
              headers: { 'Content-Type': 'application/octet-stream' },
              body: rest,
              signal,
              what: t('dest.err.fileRejected'),
              timeoutMs: uploadTimeout(rest.size),
            })
          );
          onProgress(rest.size);
          return { size: rest.size };
        }
        if (rest.size) await sendPart(rest);
        const xml =
          '<CompleteMultipartUpload>' +
          parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join('') +
          '</CompleteMultipartUpload>';
        const res = await this.request('POST', this.objectUrl(key, `?uploadId=${uriEncode(uploadId)}`), {
          headers: { 'Content-Type': 'application/xml' },
          body: xml,
          signal,
          what: t('dest.err.noAssemble'),
        });
        const text = await res.text();
        // Ошибка сборки может прийти и с кодом 200.
        if (/<Error>/.test(text)) throw s3Error(500, text, t('dest.err.noAssemble'));
        return { size: done };
      } catch (e) {
        if (uploadId) {
          this.request('DELETE', this.objectUrl(key, `?uploadId=${uriEncode(uploadId)}`)).catch(() => {});
        }
        throw e;
      }
    }

    async test() {
      const key = joinKey(this.prefix, `.ydd-test-${Date.now()}.txt`);
      await this.request('PUT', this.objectUrl(key), {
        headers: { 'Content-Type': 'text/plain' },
        body: 'ok',
        what: t('dest.err.probe'),
      });
      await this.request('DELETE', this.objectUrl(key)).catch(() => {});
      return true;
    }
  }

  function createDestination(cfg) {
    if (!cfg || cfg.type === 'local') return null;
    if (cfg.type === 'webdav') return new WebDavDestination(cfg);
    if (cfg.type === 's3') return new S3Destination(cfg);
    throw new DestError('DEST_CONFIG', t('dest.err.unknownType', { type: cfg.type }));
  }

  // Серверы Яндекса, с которых переносятся файлы (ссылки на скачивание и узлы хранения).
  const YANDEX_MEDIA_ORIGINS = [
    'https://*.disk.yandex.ru/*',
    'https://*.disk.yandex.com/*',
    'https://*.disk.yandex.net/*',
    'https://*.storage.yandex.net/*',
    'https://*.storage.yandex.ru/*',
  ];

  Object.assign(YDD, {
    DestError,
    WebDavDestination,
    S3Destination,
    createDestination,
    signV4,
    uriEncode,
    basicAuth,
    sha256Hex,
    joinKey,
    YANDEX_MEDIA_ORIGINS,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = YDD;
})(typeof globalThis !== 'undefined' ? globalThis : this);
