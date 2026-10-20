/*
 * Публичные ссылки (disk.yandex.ru/d/…): официальный REST API Яндекс Диска,
 * авторизация не нужна.
 */
(function (root) {
  'use strict';
  const YDD = (root.YDD = root.YDD || {});
  const t = (key, vars) => (YDD.t ? YDD.t(key, vars) : key);
  const { ApiError, Limiter, sleep, absoluteUrl } = YDD;

  const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';

  class PublicApi {
    constructor({ publicKey, bgFetch, retryBaseMs = 2000, minRateBackoffMs = 15000, gapMs = 150 }) {
      this.publicKey = publicKey;
      this.bgFetch = bgFetch; // запасной путь через фоновый скрипт, если CORS не пропустит
      this.limiter = new Limiter({ concurrency: 4, gapMs });
      this.retryBaseMs = retryBaseMs;
      this.minRateBackoffMs = minRateBackoffMs;
      this.rateBackoff = 0;
      this.onRateLimit = null;
    }

    /** «https://disk.yandex.ru/d/abc/Папка» → ключ ссылки и путь внутри неё. */
    static parseLocation(loc) {
      const m = /^\/(d|i)\/([^/]+)(\/.*)?$/.exec(loc.pathname);
      if (!m) return null;
      const inner = (m[3] || '')
        .split('/')
        .filter(Boolean)
        .map((s) => {
          try {
            return decodeURIComponent(s);
          } catch (e) {
            return s;
          }
        });
      return { publicKey: `${loc.origin}/${m[1]}/${m[2]}`, path: '/' + inner.join('/'), hash: m[2] };
    }

    async getJson(url, timeout) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        let status;
        let data = null;
        let retryAfter = 0;
        try {
          const res = await fetch(url, { credentials: 'omit', signal: ctrl.signal });
          status = res.status;
          retryAfter = Number(res.headers.get('Retry-After')) || 0;
          data = await res.json().catch(() => null);
        } catch (e) {
          if (ctrl.signal.aborted || !this.bgFetch) throw e;
          const viaBg = await this.bgFetch(url);
          if (!viaBg || viaBg.networkError) throw e;
          status = viaBg.status;
          data = viaBg.data;
        }
        return { status, data, retryAfter };
      } catch (e) {
        const timedOut = ctrl.signal.aborted;
        throw new ApiError(timedOut ? t('api.timeout') : t('api.offline'), {
          kind: timedOut ? 'timeout' : 'network',
          retryable: true,
        });
      } finally {
        clearTimeout(timer);
      }
    }

    async call(suffix, params, { timeout = 60000, attempts = 3 } = {}) {
      const qs = new URLSearchParams(Object.assign({ public_key: this.publicKey }, params));
      const url = `${API}${suffix}?${qs}`;
      let lastError = null;
      let rateRetries = 0;
      for (let attempt = 1; attempt <= attempts; ) {
        await this.limiter.acquire();
        let res = null;
        try {
          res = await this.getJson(url, timeout);
        } catch (e) {
          lastError = e;
        } finally {
          this.limiter.release();
        }
        if (res) {
          if (res.status >= 200 && res.status < 300 && res.data) {
            this.rateBackoff = 0;
            return res.data;
          }
          lastError = classify(res);
          if (lastError.kind === 'ratelimit' && rateRetries++ < 10) {
            this.rateBackoff = Math.min(300000, Math.max(this.minRateBackoffMs, this.rateBackoff * 2));
            const wait = res.retryAfter ? Math.min(600000, res.retryAfter * 1000) : this.rateBackoff;
            this.limiter.pauseFor(wait);
            if (this.onRateLimit) this.onRateLimit(wait);
            continue;
          }
        }
        if (!lastError.retryable || attempt >= attempts) break;
        await sleep(Math.min(30000, this.retryBaseMs * 2 ** (attempt - 1)) + Math.random() * (this.retryBaseMs / 2));
        attempt++;
      }
      throw lastError;
    }

    async listDir(path, cursor) {
      const limit = 100;
      const offset = (cursor && cursor.offset) || 0;
      const data = await this.call(
        '',
        { path, limit, offset, preview_size: 'XXXL', preview_crop: 'false' },
        { timeout: 90000, attempts: 4 }
      );
      if (data.type === 'file') return { items: [normalize(data)], next: null, self: normalize(data) };
      const emb = data._embedded;
      if (!emb || !Array.isArray(emb.items)) {
        throw new ApiError(t('api.badListing'), { kind: 'api', retryable: true });
      }
      const items = emb.items.map(normalize);
      const total = Number(emb.total);
      const nextOffset = offset + items.length;
      const done = !items.length || (Number.isFinite(total) ? nextOffset >= total : items.length < limit);
      return { items, next: done ? null : { offset: nextOffset }, self: normalize(data) };
    }

    async getFileUrl(path) {
      const data = await this.call('/download', { path }, { timeout: 90000, attempts: 3 });
      const url = absoluteUrl(data && data.href);
      if (!url) throw new ApiError(t('api.noLink'), { kind: 'api', retryable: true });
      return url;
    }

    async info(path) {
      const data = await this.call('', { path, limit: 0, preview_size: 'XXXL', preview_crop: 'false' }, { attempts: 2 });
      return normalize(data);
    }
  }

  function classify(res) {
    const err = (res.data && (res.data.error || res.data.message)) || '';
    const s = res.status;
    if (s === 429) return new ApiError(t('api.rateLimit'), { kind: 'ratelimit', status: s });
    if (s === 404) return new ApiError(t('api.publicNotFound'), { kind: 'notfound', status: s });
    if (s === 403 && /Limit/i.test(err)) {
      return new ApiError(t('api.publicLimit'), { kind: 'forbidden', status: s });
    }
    if (s === 401 || s === 403) return new ApiError(t('api.publicForbidden'), { kind: 'forbidden', status: s });
    if (s >= 500 || !s) return new ApiError(t('api.serverError', { status: s }), { kind: 'server', status: s, retryable: true });
    return new ApiError(t('api.error', { code: `HTTP ${s}${err ? ': ' + err : ''}` }), { kind: 'api', status: s });
  }

  function normalize(r) {
    return {
      id: r.path,
      name: r.name || YDD.basename(r.path || ''),
      type: r.type === 'dir' ? 'dir' : 'file',
      size: Number.isFinite(r.size) ? r.size : null,
      mediaType: r.media_type || null,
      sizes: r.preview ? [{ name: 'XXXL', url: r.preview }] : null,
      virus: r.antivirus_status === 'infected',
      partial: false,
      mtime: Math.floor((Date.parse(r.modified || '') || 0) / 1000),
    };
  }

  Object.assign(YDD, { PublicApi });
})(typeof globalThis !== 'undefined' ? globalThis : this);
