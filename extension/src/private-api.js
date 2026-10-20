/*
 * Внутренний API веб-версии Яндекс Диска (тот же, что использует сам сайт):
 * POST /models-v2?m=<метод>, тело {sk, connection_id, apiMethod, requestParams}.
 * Запросы идут из вкладки Диска, поэтому работают с текущей сессией пользователя.
 */
(function (root) {
  'use strict';
  const YDD = (root.YDD = root.YDD || {});
  const t = (key, vars) => (YDD.t ? YDD.t(key, vars) : key);
  const { sleep, absoluteUrl } = YDD;

  class ApiError extends Error {
    constructor(message, info = {}) {
      super(message);
      this.name = 'ApiError';
      Object.assign(this, info);
    }
    // Ошибки, при которых продолжать бессмысленно, пока пользователь что-то не сделает.
    get fatal() {
      return this.kind === 'auth' || this.kind === 'captcha';
    }
  }

  /** Не больше N запросов одновременно, пауза между запросами и общий стоп при 429. */
  class Limiter {
    constructor({ concurrency = 4, gapMs = 150 } = {}) {
      this.concurrency = concurrency;
      this.gapMs = gapMs;
      this.active = 0;
      this.queue = [];
      this.lastStart = 0;
      this.pausedUntil = 0;
      this.timer = null;
    }
    acquire() {
      return new Promise((resolve) => {
        this.queue.push(resolve);
        this.pump();
      });
    }
    release() {
      this.active--;
      this.pump();
    }
    pauseFor(ms) {
      this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.pump();
    }
    pump() {
      if (this.timer) return;
      while (this.queue.length && this.active < this.concurrency) {
        const now = Date.now();
        const wait = Math.max(this.pausedUntil - now, this.lastStart + this.gapMs - now);
        if (wait > 0) {
          this.timer = setTimeout(() => {
            this.timer = null;
            this.pump();
          }, wait);
          return;
        }
        this.active++;
        this.lastStart = now;
        this.queue.shift()();
      }
    }
  }

  function errorText(err) {
    try {
      return JSON.stringify(err);
    } catch (e) {
      return String(err);
    }
  }

  class PrivateApi {
    constructor(env, { retryBaseMs = 2000, minRateBackoffMs = 15000, gapMs = 150 } = {}) {
      this.origin = env.origin;
      this.sk = env.sk;
      this.connectionId = env.connectionId || '';
      this.uid = env.uid || '';
      this.limiter = new Limiter({ concurrency: 4, gapMs });
      this.retryBaseMs = retryBaseMs;
      this.minRateBackoffMs = minRateBackoffMs;
      this.rateBackoff = 0;
      this.onRateLimit = null;
    }

    /** Данные текущего пользователя из страницы Диска (<script id="preloaded-data">). */
    static readEnv(doc, loc) {
      let data = null;
      const el = doc.getElementById('preloaded-data');
      if (el) {
        try {
          data = JSON.parse(el.textContent);
        } catch (e) {
          data = null;
        }
      }
      const config = (data && data.config) || {};
      const user = (data && (data.userCurrent || data.user)) || {};
      let sk = config.sk;
      if (!sk) {
        const m = /"sk"\s*:\s*"([^"]+)"/.exec(doc.documentElement.innerHTML);
        if (m) sk = m[1];
      }
      return {
        origin: loc.origin,
        sk: sk || '',
        connectionId: config.idClient || user.connection_id || '',
        uid: String(user.uid || user.id || ''),
        login: user.login || '',
        space: (data && data.space) || null,
        photounlimAvailable: !!(data && data.space && (data.space.photounlim > 0 || data.space.actual_photounlim_size > 0)),
      };
    }

    async call(method, params, { timeout = 60000, attempts = 3 } = {}) {
      let ckeyRetries = 0;
      let rateRetries = 0;
      let lastError = null;
      for (let attempt = 1; attempt <= attempts; ) {
        await this.limiter.acquire();
        let outcome;
        try {
          outcome = await this.requestOnce(method, params, timeout);
        } finally {
          this.limiter.release();
        }
        const error = outcome.error;
        if (!error) {
          this.rateBackoff = 0;
          return outcome.data;
        }
        if (error.kind === 'ckey') {
          // Секретный ключ страницы (sk) устарел — сервер прислал новый.
          if (ckeyRetries++ < 3) {
            this.sk = error.ckey;
            continue;
          }
          throw new ApiError(t('api.sessionExpired'), { kind: 'auth' });
        }
        if (error.kind === 'ratelimit' && rateRetries++ < 10) {
          this.rateBackoff = Math.min(300000, Math.max(this.minRateBackoffMs, this.rateBackoff * 2));
          const wait = error.retryAfter ? Math.min(600000, error.retryAfter * 1000) : this.rateBackoff;
          this.limiter.pauseFor(wait);
          if (this.onRateLimit) this.onRateLimit(wait);
          continue;
        }
        lastError = error;
        if (!error.retryable || attempt >= attempts) break;
        await sleep(Math.min(30000, this.retryBaseMs * 2 ** (attempt - 1)) + Math.random() * (this.retryBaseMs / 2));
        attempt++;
      }
      throw lastError;
    }

    async requestOnce(method, params, timeout) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const body = { sk: this.sk };
      if (this.connectionId) body.connection_id = this.connectionId;
      body.apiMethod = method;
      if (params !== undefined) body.requestParams = params;
      try {
        const res = await fetch(`${this.origin}/models-v2?m=${method}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Retpath-Y': location.href,
          },
          credentials: 'same-origin',
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        let data = null;
        try {
          data = await res.json();
        } catch (e) {
          if (ctrl.signal.aborted) throw e;
          data = null;
        }
        return this.classify(res, data);
      } catch (e) {
        const timedOut = ctrl.signal.aborted;
        return {
          error: new ApiError(timedOut ? t('api.timeout') : t('api.offline'), {
            kind: timedOut ? 'timeout' : 'network',
            retryable: true,
          }),
        };
      } finally {
        clearTimeout(timer);
      }
    }

    classify(res, data) {
      const status = res.status;
      const err = data && data.error;
      const hasError = err !== undefined && err !== null && err !== false;
      if (data && data.type === 'captcha') {
        const page = data.captcha && data.captcha['captcha-page'];
        return {
          error: new ApiError(t('api.captcha'), { kind: 'captcha', captchaUrl: page || null }),
        };
      }
      if (res.ok && data && !hasError) return { data };
      const text = hasError ? errorText(err) : '';
      const code = hasError ? String(err.code || err.id || err.name || '') : '';
      if (code === 'CKEY') {
        if (err.uid && this.uid && String(err.uid) !== String(this.uid)) {
          return { error: new ApiError(t('api.accountChanged'), { kind: 'auth' }) };
        }
        if (err.ckey) return { error: new ApiError('CKEY', { kind: 'ckey', ckey: err.ckey }) };
        return { error: new ApiError(t('api.sessionExpired'), { kind: 'auth' }) };
      }
      if (status === 401 || /NEED_UPDATE|UNAUTHORIZED|NO_AUTH|AUTH_REQUIRED/i.test(code)) {
        return { error: new ApiError(t('api.relogin'), { kind: 'auth', status }) };
      }
      if (status === 429 || /TOO_MANY|RATE_?LIMIT/i.test(code)) {
        const retryAfter = Number(res.headers.get('Retry-After')) || 0;
        return { error: new ApiError(t('api.rateLimit'), { kind: 'ratelimit', status, retryAfter }) };
      }
      if (status === 404 || /NOT_?FOUND|HTTP_404|"404"|DoesNotExist/i.test(code + text)) {
        return { error: new ApiError(t('api.notFound'), { kind: 'notfound', status, code }) };
      }
      if (status === 403 || /FORBIDDEN|HTTP_403|ACCESS_?DENIED/i.test(code)) {
        return { error: new ApiError(t('api.forbidden'), { kind: 'forbidden', status, code }) };
      }
      if (status >= 500 || status === 0 || !data) {
        return { error: new ApiError(t('api.serverError', { status }), { kind: 'server', status, retryable: true }) };
      }
      return {
        error: new ApiError(t('api.error', { code: code || 'HTTP ' + status }), { kind: 'api', status, code, retryable: res.ok }),
      };
    }

    // --- Методы -------------------------------------------------------------
    /** Одна страница содержимого папки. Повторяет логику сайта: порция 40, сортировка по имени. */
    async listDir(path, cursor) {
      const amount = 40;
      const params = { idContext: path, sort: 'name', order: '1', amount, with_share: '1' };
      if (cursor && cursor.iterationKey) params.iteration_key = cursor.iterationKey;
      else params.offset = (cursor && cursor.offset) || 0;
      const data = await this.call('mpfs/resources', params, { timeout: 90000, attempts: 4 });
      if (!data || !Array.isArray(data.resources)) {
        throw new ApiError(t('api.badListing'), { kind: 'api', retryable: true });
      }
      const items = data.resources.filter((r) => r && r.id !== path);
      const countLost = Number(data.countLost) || 0;
      const iterationKey = data.iteration_key || null;
      const done = data.resources.length + countLost < amount && !iterationKey;
      return {
        items: items.map(normalizeResource),
        next: done ? null : { offset: ((cursor && cursor.offset) || 0) + items.length, iterationKey },
      };
    }

    async getFileUrl(path) {
      const data = await this.call('mpfs/url', { path }, { timeout: 90000, attempts: 3 });
      const url = absoluteUrl(data && data.file);
      if (!url) throw new ApiError(t('api.noLink'), { kind: 'api', retryable: true });
      return url;
    }

    async info(path) {
      const data = await this.call('mpfs/info', { path }, { timeout: 60000, attempts: 2 });
      return normalizeResource(data);
    }

    // «Фото» (в том числе Безлимит): снимок раздела, кластеры по датам, файлы кластеров.
    async photosliceInit() {
      const data = await this.call('intapi/photo-init-snapshot', undefined, { timeout: 90000, attempts: 3 });
      const id = data && (data.photoslice_id || data.photosliceId || data.id);
      if (!id) throw new ApiError(t('api.noPhotoslice'), { kind: 'api' });
      return id;
    }

    async photosliceClusters(photosliceId) {
      const clusters = [];
      const seen = new Set();
      let offset = 0;
      for (let guard = 0; guard < 1000; guard++) {
        const params = { id: photosliceId, locale: 'ru' };
        if (offset) Object.assign(params, { offset, amount: 500 });
        const data = await this.call('intapi/photo-get-snapshot', params, { timeout: 120000, attempts: 3 });
        const items = (data && (data.items || (data.clusters && data.clusters.items))) || [];
        let added = 0;
        for (const c of items) {
          const id = c && (c.id || c.cluster_id);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          clusters.push({ id, size: Number(c.size) || 0, unlim: Number(c.albums && c.albums.photounlim) || 0 });
          added++;
        }
        const total = Number(data && data.total) || 0;
        offset += items.length;
        if (!added || !total || offset >= total) break;
      }
      return clusters;
    }

    /** Файлы из нескольких кластеров. request: {clusterId: [from, to]}. */
    async photosliceResources(photosliceId, request) {
      const clusters = {};
      for (const [id, range] of Object.entries(request)) clusters[id] = { range };
      const data = await this.call(
        'intapi/photo-get-clusters-with-resources',
        { photosliceId, clusters, hideScreenshots: false },
        { timeout: 120000, attempts: 3 }
      );
      const byId = new Map();
      const addMeta = (r) => {
        if (!r) return;
        const id = r.id || r.path;
        if (typeof id === 'string') byId.set(id, Object.assign(byId.get(id) || {}, r));
      };
      let resources = data && data.resources;
      if (resources && !Array.isArray(resources)) {
        if (Array.isArray(resources.fetched)) resources = resources.fetched;
        else if (resources.error && Array.isArray(resources.requested) && resources.requested.length) {
          resources = await this.call('mpfs/bulk-resource-info', { ids: resources.requested, photoslice: true }, { timeout: 120000 });
        } else resources = [];
      }
      if (Array.isArray(resources)) resources.forEach(addMeta);
      const ids = new Set();
      const fetched = (data && data.clusters && data.clusters.fetched) || [];
      for (const cluster of fetched) {
        const range = request[cluster.id];
        let items = Array.isArray(cluster.items) ? cluster.items : [];
        // Сервер иногда возвращает весь список кластера, а не запрошенный диапазон.
        if (range && items.length > range[1] - range[0] + 1) items = items.slice(range[0], range[1] + 1);
        for (const it of items) {
          const id = typeof it === 'string' ? it : it && (it.id || it.path);
          if (typeof id === 'string') {
            ids.add(id);
            if (typeof it === 'object') addMeta(it);
          }
        }
      }
      for (const id of byId.keys()) ids.add(id);
      return [...ids].map((id) => normalizeResource(Object.assign({ id }, byId.get(id))));
    }
  }

  /** Время изменения в секундах (для дат файлов в архиве); 0 — неизвестно. */
  function unixSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n > 1e11 ? n / 1000 : n);
  }

  /** Приводим ресурс Диска к компактному виду, который нужен загрузчику. */
  function normalizeResource(r) {
    const meta = (r && r.meta) || {};
    const id = r && (r.id || r.path);
    return {
      id,
      name: (r && r.name) || YDD.basename(id || ''),
      type: r && r.type === 'dir' ? 'dir' : 'file',
      size: Number.isFinite(Number(meta.size)) && meta.size !== '' && meta.size != null ? Number(meta.size) : null,
      mediaType: meta.mediatype || null,
      sizes: Array.isArray(meta.sizes) ? meta.sizes : null,
      virus: meta.drweb === 2,
      partial: !!(r && r.state && r.state.part),
      mtime: unixSeconds(r && (r.mtime || r.utime || r.ctime)) || unixSeconds(meta.etime),
    };
  }

  Object.assign(YDD, { ApiError, Limiter, PrivateApi, normalizeResource });
})(typeof globalThis !== 'undefined' ? globalThis : this);
