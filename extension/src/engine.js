/*
 * Движок: обходит папки, ставит файлы в очередь и скачивает их по одному
 * через chrome.downloads, повторяя неудачные попытки и сохраняя прогресс.
 */
(function (root) {
  'use strict';
  const YDD = (root.YDD = root.YDD || {});
  const { ST, CHUNK, PathAllocator, fitPath, strictPath, previewName, isImage, originalFromSizes, pickPreview } = YDD;
  const { basename, isYandexUrl, joinPath, sanitizeComponent, shortHash, truncateComponent, fileExt, typeGroup, TYPE_GROUPS } = YDD;
  // Строки интерфейса; в тестах без словаря — сам ключ.
  const t = (key, vars) => (YDD.t ? YDD.t(key, vars) : key);

  const DEFAULT_OPTIONS = Object.freeze({
    concurrency: 4,
    preview: true,
    eraseHistory: true,
    quietUi: true,
    root: 'Яндекс Диск',
  });

  const UNLIM_BATCH = 200;
  // Сроки ожидания. «Мёртвый» файл (узел хранения не отвечает) не должен надолго занимать поток.
  const DEFAULT_TIMING = Object.freeze({
    startMs: 60000, // сколько ждать ответа сервера на запрос файла (до появления загрузки в браузере)
    firstByteMs: 45000, // сколько ждать первых байтов от сервера
    stallMs: 90000, // сколько ждать, если скачивание остановилось на середине
    slowFactor: 2.5, // во втором и следующих проходах ждём дольше
    retryDelayMs: 15000, // пауза перед повтором файла
    pollMs: 3000, // запасной опрос состояния загрузок
    flushMs: 1500, // как часто сохранять прогресс
  });
  const OK_DANGER = new Set([undefined, null, '', 'safe', 'accepted', 'allowlistedByPolicy']);
  const FINISHING_LIMIT_MS = 10 * 60 * 1000;
  // Часть архива пишется из памяти браузера на диск — если она стоит дольше, что-то не так.
  const ZIP_SAVE_STALL_MS = 10 * 60 * 1000;
  const ZIP_PART_MB = 2000;
  const isZipped = (s) => s === ST.ZIPPED || s === ST.ZIPPED_PREVIEW;

  const countsBytes = (s) => s === ST.DONE || s === ST.ZIPPED;

  /** Имя файла архива: «Отпуск 2026-10-20 14-30.zip» или «…, часть 2.zip». */
  function zipPartName(base, n, single, partWord) {
    const name = sanitizeComponent(base || 'Yandex Disk') || 'Yandex Disk';
    return single ? `${name}.zip` : `${name}, ${sanitizeComponent((partWord || 'часть {n}').replace('{n}', n))}.zip`;
  }

  /** Имена служебных папок — на языке, выбранном при создании задания. */
  function fsNames() {
    return { unlim: t('fs.unlim'), longPaths: t('fs.longPaths'), preview: t('fs.preview'), part: t('fs.part') };
  }

  function interruptResult(error, details) {
    const e = String(error || '');
    const more = details ? ` (${details})` : '';
    // Перенос в облако или на сервер
    if (e === 'DEST_AUTH' || e === 'DEST_CONFIG') return { ok: false, kind: 'destauth', message: t('err.destAuth') + more };
    if (e === 'DEST_FULL') return { ok: false, kind: 'destfull', message: t('err.destFull') + more };
    if (e === 'DEST_TOO_LARGE') return { ok: false, kind: 'local', message: t('err.destTooLarge') + more };
    if (e === 'DEST_FAILED' || e === 'DEST_NETWORK') return { ok: false, kind: 'network', message: t('err.destFailed') + more };
    if (e === 'ZIP_FAILED') return { ok: false, kind: 'zipspace', message: t('err.zipAdd') + more };
    if (e === 'SERVER_FORBIDDEN' || e === 'SERVER_BAD_CONTENT') {
      return { ok: false, kind: 'server', message: details || t('err.yandexRefused', { code: e }) };
    }
    if (e === 'FILE_NO_SPACE') return { ok: false, kind: 'nospace', message: t('err.diskFull') };
    if (e === 'FILE_NAME_TOO_LONG') return { ok: false, kind: 'toolong', message: t('err.pathTooLong') };
    if (e === 'USER_CANCELED') return { ok: false, kind: 'canceled', message: t('err.canceled') };
    if (/^FILE_(VIRUS_INFECTED|BLOCKED|SECURITY_CHECK_FAILED)$/.test(e)) return { ok: false, kind: 'local', message: t('err.blocked', { code: e }) };
    if (/^FILE_(ACCESS_DENIED|TOO_LARGE|FAILED|TOO_SHORT|SAME_AS_SOURCE)$/.test(e)) return { ok: false, kind: 'local', message: t('err.writeFailed', { code: e }) };
    if (e.startsWith('SERVER_')) return { ok: false, kind: 'server', message: t('err.serverInterrupted', { code: e }) };
    return { ok: false, kind: 'network', message: t('err.interrupted', { code: (e || t('err.noCode')) + (details ? ': ' + details : '') }) };
  }

  /** Следит за загрузками браузера: события от фонового скрипта + редкий опрос. */
  class DownloadMonitor {
    constructor(bg, pollMs = DEFAULT_TIMING.pollMs) {
      this.bg = bg;
      this.pollMs = pollMs;
      this.tracked = new Map();
      this.timer = null;
      bg.onChanged((item) => this.handle(item));
    }

    track(id, opts) {
      return new Promise((resolve) => {
        const now = Date.now();
        this.tracked.set(id, { resolve, opts, start: now, lastBytes: -1, lastChange: now, saveAs: false });
        if (!this.timer) this.timer = setInterval(() => this.poll(), this.pollMs);
        this.poll([id]);
      });
    }

    async poll(ids) {
      const list = ids || [...this.tracked.keys()];
      if (!list.length) {
        if (!this.tracked.size && this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
        return;
      }
      const res = await this.bg.status(list);
      if (!res || !res.ok) return;
      for (const id of list) this.handle(res.items[id] || { id, missing: true });
    }

    handle(item) {
      const w = item && this.tracked.get(item.id);
      if (!w) return;
      const now = Date.now();
      if (item.missing) {
        // Перенос в облако (id «t…») мог прерваться вместе с браузером — просто повторим.
        return this.settle(
          item.id,
          typeof item.id === 'string'
            ? { ok: false, kind: 'network', message: t('err.transferLost') }
            : { ok: false, kind: 'canceled', message: t('err.downloadGone') }
        );
      }
      if (item.state === 'complete') {
        const result = { ok: true, bytes: item.fileSize > 0 ? item.fileSize : item.bytesReceived };
        if (item.part) Object.assign(result, { part: item.part, sealed: item.sealed || [] });
        return this.settle(item.id, result);
      }
      if (item.state === 'interrupted') return this.settle(item.id, interruptResult(item.error, item.message));
      if (!OK_DANGER.has(item.danger)) {
        if (w.opts.waitDanger) {
          // Архив целиком: ждём, пока пользователь подтвердит его в списке загрузок.
          w.lastChange = now;
          if (w.opts.onProgress) w.opts.onProgress(item);
          return;
        }
        return this.settle(item.id, { ok: false, kind: 'danger', message: t('err.needsConfirm') });
      }
      // busy — файл отправляется в облако: прогресса не видно, но у отправки свой предел времени.
      if (item.bytesReceived !== w.lastBytes || item.busy) {
        w.lastBytes = item.bytesReceived;
        w.lastChange = now;
      }
      if (w.opts.onProgress) w.opts.onProgress(item);
      if (!item.filename && !w.saveAs && now - w.start > 10000) {
        // Имя файла так и не назначено — браузер показывает окно «Сохранить как».
        w.saveAs = true;
        if (w.opts.onSaveAs) w.opts.onSaveAs();
      }
      if (w.saveAs || item.paused) return;
      if (item.totalBytes > 0 && item.bytesReceived >= item.totalBytes) {
        // Все байты получены, браузер проверяет файл (Safe Browsing и т. п.) — это не зависание.
        if (!w.finishingSince) w.finishingSince = now;
        if (now - w.finishingSince < FINISHING_LIMIT_MS) return;
      }
      const limit = item.bytesReceived > 0 ? w.opts.stallMs : w.opts.firstByteMs;
      if (now - w.lastChange > limit) {
        console.warn('[YDD] загрузка не двигается, отменяем', JSON.stringify(item), 'без изменений, мс:', now - w.lastChange);
        this.settle(item.id, {
          ok: false,
          kind: 'stalled',
          message: item.bytesReceived > 0 ? t('err.stalled') : t('err.noResponse'),
        });
        this.bg.cancel(item.id);
      }
    }

    settle(id, result) {
      const w = this.tracked.get(id);
      if (!w) return;
      this.tracked.delete(id);
      w.resolve(result);
    }

    cancelAll() {
      for (const id of [...this.tracked.keys()]) {
        this.settle(id, { ok: false, kind: 'stopped' });
        this.bg.cancel(id);
      }
    }
  }

  class SpeedMeter {
    constructor(windowMs = 30000) {
      this.windowMs = windowMs;
      this.samples = [];
    }
    add(total) {
      const now = Date.now();
      const last = this.samples[this.samples.length - 1];
      if (last && now - last[0] < 500) return;
      this.samples.push([now, total]);
      while (this.samples.length > 2 && now - this.samples[0][0] > this.windowMs) this.samples.shift();
    }
    rate() {
      if (this.samples.length < 2) return 0;
      const [t0, b0] = this.samples[0];
      const [t1, b1] = this.samples[this.samples.length - 1];
      return t1 - t0 > 2000 ? Math.max(0, ((b1 - b0) * 1000) / (t1 - t0)) : 0;
    }
    reset() {
      this.samples = [];
    }
  }

  function csvCell(value) {
    let s = String(value == null ? '' : value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  class Engine {
    constructor({ source, bg, store, account, sourceInfo, timing }) {
      this.source = source;
      this.bg = bg;
      this.store = store;
      this.account = account;
      this.sourceInfo = sourceInfo;
      this.timing = Object.assign({}, DEFAULT_TIMING, timing);
      this.job = null;
      this.listeners = new Set();
      this.token = 0;
      this.liveToken = 0;
      this.monitor = new DownloadMonitor(bg, this.timing.pollMs);
      this.speed = new SpeedMeter();
      this.emitTimer = null;
      this.flushTimer = null;
      this.resetRuntime();
      source.onRateLimit = (ms) => {
        this.rateLimitedUntil = Date.now() + ms;
        this.emit();
      };
    }

    resetRuntime() {
      this.claimed = new Set();
      this.deferred = [];
      this.adoptQueue = [];
      this.cursor = 0;
      this.inflight = 0;
      this.dirtyFiles = new Set();
      this.dirtySt = new Set();
      this.dirtyMeta = false;
      this.alloc = new PathAllocator();
      this.seenFiles = new Set();
      this.seenDirs = new Set();
      this.active = new Map();
      this.counts = {};
      this.bytesDone = 0;
      this.blocked = null;
      this.waiters = [];
      this.rateLimitedUntil = 0;
      this.saveAsSuspected = false;
      this.carry = null;
      // Архив: части, закрытые и ждущие сохранения; сохранение, начатое до перезагрузки страницы.
      this.zipQueue = [];
      this.zipAdopt = null;
      this.zipActive = false;
      // Когда файл лёг в архив (порядковый номер) — чтобы сверка не отменила только что добавленное.
      this.zipMarks = new Map();
      this.zipSeq = 0;
      // Типы файлов: расширение → сколько файлов и байтов; выбранные типы; объём отфильтрованного.
      this.types = new Map();
      this.filterSet = null;
      this.excludedBytes = 0;
      this.speed.reset();
    }

    // --- События для интерфейса ------------------------------------------------
    on(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    emit() {
      if (this.emitTimer) return;
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        const snap = this.snapshot();
        for (const fn of this.listeners) fn(snap);
      }, 250);
    }

    // --- Задание ----------------------------------------------------------------
    async loadCurrent() {
      const id = await this.store.getPointer(this.account);
      if (!id) return null;
      const job = await this.store.load(id);
      if (!job) {
        await this.store.setPointer(this.account, null);
        return null;
      }
      this.job = job;
      this.resetRuntime();
      this.rebuild();
      // Задание шло, когда страницу закрыли или перезагрузили. Решение о продолжении — за content.js.
      this.interrupted = job.meta.phase === 'running';
      if (this.interrupted) job.meta.phase = 'paused';
      return job;
    }

    rebuild() {
      const { files, st, meta } = this.job;
      this.filterSet = meta.filter && meta.filter.exts ? new Set(meta.filter.exts) : null;
      for (let i = 0; i < files.length; i++) {
        const [remote, local, size, media] = files[i];
        this.seenFiles.add(remote);
        this.alloc.restore(local, remote);
        this.counts[st[i]] = (this.counts[st[i]] || 0) + 1;
        if (countsBytes(st[i])) this.bytesDone += size || 0;
        if (st[i] === ST.EXCLUDED) this.excludedBytes += size || 0;
        this.noteType(fileExt(basename(remote)), size, media);
      }
      const restoreDir = (d) => {
        this.seenDirs.add(d.path);
        if (d.local) this.alloc.restore(d.local, 'dir:' + d.path);
      };
      for (const d of meta.scan.stack) {
        restoreDir(d);
        d.subdirs.forEach(restoreDir);
      }
      for (const e of meta.scan.errors) this.seenDirs.add(e.path);
      if (meta.unlimLocal) this.alloc.restore(meta.unlimLocal, 'dir:/photounlim');
      for (const [key, downloadId] of Object.entries(meta.active || {})) {
        const idx = Number(key);
        if (st[idx] === ST.PENDING && !this.claimed.has(idx)) {
          this.claimed.add(idx);
          this.adoptQueue.push({ idx, attempt: 1, downloadId });
        }
      }
    }

    // --- Типы файлов -------------------------------------------------------------------
    noteType(ext, size, mediaType) {
      let entry = this.types.get(ext);
      if (!entry) {
        entry = { ext, count: 0, bytes: 0, group: typeGroup(ext, mediaType) };
        this.types.set(ext, entry);
      }
      entry.count++;
      entry.bytes += size || 0;
    }

    extWanted(ext) {
      return !this.filterSet || this.filterSet.has(ext);
    }

    needsFilter() {
      const f = this.job && this.job.meta.filter;
      return !!(f && f.pending);
    }

    /** Найденные типы по группам: фото, видео, документы… — для окна выбора. */
    typeStats() {
      const groups = new Map(TYPE_GROUPS.map((g) => [g.id, { id: g.id, count: 0, bytes: 0, exts: [] }]));
      for (const t of this.types.values()) {
        const g = groups.get(t.group) || groups.get('other');
        g.count += t.count;
        g.bytes += t.bytes;
        g.exts.push({ ext: t.ext, count: t.count, bytes: t.bytes });
      }
      const out = [...groups.values()].filter((g) => g.count);
      for (const g of out) g.exts.sort((a, b) => b.bytes - a.bytes || b.count - a.count || a.ext.localeCompare(b.ext));
      return out;
    }

    /** Скачивать только эти типы (расширения; '' — файлы без расширения). Можно менять в любой момент. */
    applyFilter(exts) {
      if (!this.job) return;
      const { files, st, meta } = this.job;
      meta.filter = { exts: [...new Set(exts)].sort() };
      this.filterSet = new Set(meta.filter.exts);
      for (let i = 0; i < files.length; i++) {
        const want = this.filterSet.has(fileExt(basename(files[i][0])));
        if (!want && st[i] === ST.PENDING && !this.claimed.has(i)) this.setStatus(i, ST.EXCLUDED);
        else if (want && st[i] === ST.EXCLUDED) this.setStatus(i, ST.PENDING);
      }
      this.cursor = 0;
      if (this.blocked && this.blocked.kind === 'filter') this.blocked = null;
      // Добавили типы к уже законченному заданию — оно снова не закончено.
      if (meta.phase === 'done' && this.counts[ST.PENDING]) {
        meta.phase = 'paused';
        delete meta.finishedAt;
      }
      this.markMeta();
      this.notifyWork();
      this.emit();
    }

    /** Имена служебных папок этого задания (у заданий из прошлых версий — по текущему языку). */
    names() {
      return (this.job && this.job.meta.names) || fsNames();
    }

    /** «IMG_1.jpg» → «IMG_1 (превью).jpg» на языке задания. */
    previewOf(local) {
      return previewName(local, this.names().preview);
    }

    /** Карта «путь → размер» успешно скачанных файлов — чтобы не качать их повторно. */
    doneMap() {
      const map = new Map();
      if (!this.job) return map;
      const { files, st } = this.job;
      for (let i = 0; i < files.length; i++) if (st[i] === ST.DONE) map.set(files[i][0], files[i][2]);
      return map;
    }

    async createJob({ scope, options, carry, filter }) {
      const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const meta = {
        id,
        v: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: this.sourceInfo,
        scope: { type: scope.type, label: scope.label, unlim: !!scope.unlim },
        opt: Object.assign({}, DEFAULT_OPTIONS, { root: t('fs.root') }, options),
        phase: 'new',
        pass: 1,
        fileCount: 0,
        totalBytes: 0,
        reused: 0,
        scan: { stack: [], done: false, dirs: 0, errors: [], unlim: { state: scope.unlim ? 'pending' : 'skip' } },
        errors: {},
        notes: {},
        active: {},
        // Типы файлов: pending — сначала найти всё и спросить, какие типы скачивать.
        filter: filter === 'ask' ? { pending: true, exts: null } : null,
        names: fsNames(),
      };
      if (meta.opt.dest && meta.opt.dest.type === 'zip') meta.zip = { next: 1, parts: [], saving: null, fails: {} };
      this.job = { meta, files: [], st: [] };
      this.resetRuntime();
      this.carry = carry && carry.size ? carry : null;
      for (let i = scope.roots.length - 1; i >= 0; i--) {
        const r = scope.roots[i];
        const filter = r.filter ? r.filter.map((n) => String(n).normalize('NFC')) : null;
        meta.scan.stack.push({ path: r.path, local: r.local || '', cursor: null, subdirs: [], filter });
        this.seenDirs.add(r.path);
        if (r.local) this.alloc.restore(r.local, 'dir:' + r.path);
      }
      // Файлы, отмеченные вручную: о них уже всё известно, папку целиком перебирать не нужно.
      for (const f of scope.files || []) this.addFile(f.item, f.parentLocal || '');
      await this.store.setPointer(this.account, id);
      await this.flush(true);
      this.emit();
      return this.job;
    }

    async discard() {
      if (!this.job) return;
      const id = this.job.meta.id;
      const zip = this.isZip();
      this.token++;
      this.monitor.cancelAll();
      // Несохранённые части архива больше не нужны — освобождаем временное место.
      if (zip) this.bg.zipDrop(id);
      await this.afterStop();
      await this.store.remove(id);
      await this.store.setPointer(this.account, null);
      this.job = null;
      this.resetRuntime();
      this.wakeAll();
      this.emit();
    }

    // --- Управление ---------------------------------------------------------------
    isRunning(token) {
      return this.token === token && !!this.job && this.job.meta.phase === 'running';
    }

    isZip() {
      const dest = this.job && this.job.meta.opt.dest;
      return !!(dest && dest.type === 'zip' && this.job.meta.zip);
    }

    async start() {
      if (!this.job) return;
      const meta = this.job.meta;
      if (meta.phase === 'running' && this.liveToken) return;
      if (this.needsFilter() && meta.scan.done) {
        this.blocked = { kind: 'filter', message: t('err.filter'), url: null };
        this.emit();
        return;
      }
      const lock = await this.bg.lock(meta.id);
      if (!lock || !lock.ok) {
        if (lock && lock.owner != null) this.block({ kind: 'locked', message: t('err.locked') });
        else this.block({ kind: 'dead', message: t('err.dead') });
        return;
      }
      this.blocked = null;
      this.saveAsSuspected = false;
      meta.phase = 'running';
      this.markMeta();
      const token = ++this.token;
      this.liveToken = token;
      this.bg.prepare(true, meta.opt);
      this.emit();
      try {
        const loops = [];
        if (this.isZip()) {
          // Сначала сверяемся с архивом: после перезапуска браузера несохранённые части пропадают.
          try {
            await this.zipSync(token);
          } catch (e) {
            console.error('[YDD] не удалось проверить архив', e);
          }
          // Запускаем до потоков скачивания: они не завершатся, пока архив не сохранён.
          loops.push(
            this.zipLoop(token).catch((e) => {
              console.error('[YDD] ошибка сохранения архива', e);
              this.block({ kind: 'zip', message: t('err.zipFailed', { error: (e && e.message) || e }) });
            })
          );
        }
        if (!meta.scan.done) {
          loops.push(
            this.scanLoop(token).catch((e) => {
              console.error('[YDD] ошибка обхода папок', e);
              this.block({ kind: 'error', message: t('err.scanFailed', { error: (e && e.message) || e }) });
            })
          );
        }
        const n = Math.max(1, Math.min(8, Number(meta.opt.concurrency) || 4));
        for (let i = 0; i < n; i++) loops.push(this.workerLoop(token));
        await Promise.all(loops);
      } finally {
        if (this.liveToken === token) this.liveToken = 0;
      }
      if (this.token === token && this.job && this.job.meta === meta && meta.phase === 'running' && this.isComplete()) {
        meta.phase = 'done';
        meta.finishedAt = Date.now();
        this.markMeta();
        await this.afterStop();
        // Страховка: подчистить записи, которые не стёрлись по ходу (например, загрузка,
        // начавшаяся уже после того, как её перестали ждать).
        if (meta.opt.eraseHistory && this.bg.sweep) this.bg.sweep(meta.createdAt);
      }
      await this.flush();
      this.emit();
    }

    /** Пауза: новые файлы не начинаем, текущие докачиваются. */
    async pause() {
      if (!this.job || this.job.meta.phase !== 'running') return;
      this.job.meta.phase = 'paused';
      this.token++;
      this.markMeta();
      this.wakeAll();
      await this.afterStop();
      this.emit();
    }

    /** Стоп: прерываем и текущие загрузки (продолжить можно позже). */
    async stop() {
      if (!this.job) return;
      if (this.job.meta.phase === 'running') this.job.meta.phase = 'paused';
      this.token++;
      this.monitor.cancelAll();
      this.markMeta();
      this.wakeAll();
      await this.afterStop();
      this.emit();
    }

    async afterStop() {
      if (!this.job) return;
      await this.bg.unlock(this.job.meta.id);
      this.bg.prepare(false, this.job.meta.opt);
      await this.flush();
    }

    block(info) {
      this.blocked = { kind: info.kind, message: info.message, url: info.captchaUrl || null };
      if (this.job && this.job.meta.phase === 'running') {
        this.job.meta.phase = 'paused';
        this.token++;
        this.markMeta();
        this.afterStop();
      }
      this.wakeAll();
      this.emit();
    }

    /** Ещё один проход по неудачным файлам и непрочитанным папкам. Возвращает промис прохода. */
    retryFailed() {
      const { st, meta } = this.job;
      for (let i = 0; i < st.length; i++) {
        if (st[i] === ST.FAILED) {
          // Неудачные файлы тех типов, что больше не выбраны, не повторяем.
          this.setStatus(i, this.extWanted(fileExt(basename(this.job.files[i][0]))) ? ST.PENDING : ST.EXCLUDED);
          delete meta.errors[i];
        }
      }
      for (const e of meta.scan.errors) {
        meta.scan.stack.push({ path: e.path, local: e.local, cursor: null, subdirs: [], filter: e.filter || null });
      }
      if (meta.scan.errors.length) meta.scan.done = false;
      meta.scan.errors = [];
      if (meta.scan.unlim.state === 'failed') {
        meta.scan.unlim.state = 'pending';
        meta.scan.done = false;
      }
      return this.restartPass();
    }

    retryPreviews() {
      const { st, meta } = this.job;
      for (let i = 0; i < st.length; i++) {
        if (st[i] === ST.PREVIEW) {
          this.setStatus(i, ST.PENDING);
          delete meta.notes[i];
        }
      }
      return this.restartPass();
    }

    restartPass() {
      const meta = this.job.meta;
      meta.pass = (meta.pass || 1) + 1;
      meta.phase = 'paused';
      this.cursor = 0;
      this.markMeta();
      return this.start();
    }

    isComplete() {
      const c = this.counts;
      if (this.isZip() && (c[ST.ZIPPED] || c[ST.ZIPPED_PREVIEW] || this.zipQueue.length || this.zipAdopt || this.job.meta.zip.saving)) return false;
      return (
        this.job.meta.scan.done &&
        !c[ST.PENDING] &&
        this.claimed.size === 0 &&
        this.inflight === 0 &&
        !this.deferred.length &&
        !this.adoptQueue.length
      );
    }

    // --- Обход папок ---------------------------------------------------------------
    async scanLoop(token) {
      const scan = this.job.meta.scan;
      while (this.isRunning(token) && scan.stack.length) {
        const top = scan.stack[scan.stack.length - 1];
        let page;
        try {
          page = await this.source.listDir(top.path, top.cursor);
        } catch (e) {
          if (!this.isRunning(token)) return;
          if (e.fatal) return this.block(e);
          scan.errors.push({ path: top.path, local: top.local, filter: top.filter, msg: e.message });
          scan.stack.pop();
          this.pushSubdirs(top);
          this.markMeta();
          continue;
        }
        // На паузе страницу не учитываем: курсор не сдвинулся, после продолжения запросим её снова.
        if (!this.isRunning(token)) return;
        for (const item of page.items) {
          if (top.filter && !top.filter.includes(String(item.name).normalize('NFC'))) continue;
          if (item.type === 'dir') {
            if (this.seenDirs.has(item.id)) continue;
            this.seenDirs.add(item.id);
            top.subdirs.push({ path: item.id, local: this.alloc.alloc(top.local, item.name, 'dir:' + item.id) });
          } else {
            this.addFile(item, top.local);
          }
        }
        top.cursor = page.next;
        if (!page.next) {
          scan.stack.pop();
          scan.dirs++;
          this.pushSubdirs(top);
        }
        this.markMeta();
        this.notifyWork();
        this.emit();
      }
      if (!this.isRunning(token) || scan.stack.length) return;
      if (scan.unlim.state === 'pending') await this.scanUnlim(token);
      if (this.isRunning(token) && !scan.stack.length && scan.unlim.state !== 'pending') {
        scan.done = true;
        this.markMeta();
        // Все файлы найдены, а типы ещё не выбраны — останавливаемся и спрашиваем.
        if (this.needsFilter()) return this.block({ kind: 'filter', message: t('err.filter') });
        this.notifyWork();
        this.emit();
      }
    }

    pushSubdirs(top) {
      const stack = this.job.meta.scan.stack;
      for (let i = top.subdirs.length - 1; i >= 0; i--) {
        stack.push({ path: top.subdirs[i].path, local: top.subdirs[i].local, cursor: null, subdirs: [], filter: null });
      }
    }

    addFile(item, parentLocal) {
      if (!item.id || this.seenFiles.has(item.id)) return;
      this.seenFiles.add(item.id);
      const { files, st, meta } = this.job;
      const idx = files.length;
      const local = this.alloc.alloc(parentLocal, item.name, item.id);
      files.push([item.id, local, item.size, item.mediaType || '', item.mtime || 0]);
      const ext = fileExt(item.name);
      this.noteType(ext, item.size, item.mediaType);
      let status = ST.PENDING;
      if (item.partial) {
        status = ST.SKIPPED;
        meta.notes[idx] = t('note.partial');
      } else if (this.carry && this.carry.has(item.id) && this.carry.get(item.id) === item.size) {
        status = ST.DONE;
        meta.reused = (meta.reused || 0) + 1;
      } else if (!this.extWanted(ext)) {
        status = ST.EXCLUDED;
      }
      st.push(status);
      this.counts[status] = (this.counts[status] || 0) + 1;
      if (status === ST.DONE) this.bytesDone += item.size || 0;
      if (status === ST.EXCLUDED) this.excludedBytes += item.size || 0;
      meta.fileCount = files.length;
      meta.totalBytes += item.size || 0;
      this.dirtyFiles.add(Math.floor(idx / CHUNK));
      this.dirtySt.add(Math.floor(idx / CHUNK));
    }

    /** «Безлимит для фото» не виден в «Файлах» — собираем его через раздел «Фото». */
    async scanUnlim(token) {
      const meta = this.job.meta;
      const u = meta.scan.unlim;
      try {
        if (!meta.unlimLocal) meta.unlimLocal = this.alloc.alloc('', sanitizeComponent(this.names().unlim), 'dir:/photounlim');
        if (!u.psid) u.psid = await this.source.photosliceInit();
        if (!u.clusters) {
          const all = await this.source.photosliceClusters(u.psid);
          u.clusters = all.filter((c) => c.unlim > 0 && c.size > 0).map((c) => [c.id, c.size]);
          u.expected = all.reduce((sum, c) => sum + (c.unlim || 0), 0);
          u.pos = 0;
          u.sub = 0;
          u.found = 0;
          this.markMeta();
        }
        while (this.isRunning(token) && u.pos < u.clusters.length) {
          const request = {};
          let count = 0;
          let pos = u.pos;
          let sub = u.sub || 0;
          while (pos < u.clusters.length && count < UNLIM_BATCH) {
            const [id, size] = u.clusters[pos];
            const take = Math.min(size - sub, UNLIM_BATCH - count);
            if (take <= 0) {
              pos++;
              sub = 0;
              continue;
            }
            request[id] = [sub, sub + take - 1];
            count += take;
            if (sub + take < size) {
              sub += take;
              break;
            }
            pos++;
            sub = 0;
          }
          const items = await this.source.photosliceResources(u.psid, request);
          for (const item of items) {
            if (item.type === 'dir' || !item.id || !item.id.startsWith('/photounlim/')) continue;
            const before = this.job.files.length;
            this.addFile(item, meta.unlimLocal);
            if (this.job.files.length > before) u.found++;
          }
          u.pos = pos;
          u.sub = sub;
          this.markMeta();
          this.notifyWork();
          this.emit();
        }
        if (u.pos >= u.clusters.length) u.state = 'done';
      } catch (e) {
        if (e.fatal) return this.block(e);
        if (!this.isRunning(token)) return;
        u.state = 'failed';
        u.msg = e.message;
      }
      this.markMeta();
    }

    // --- Скачивание ---------------------------------------------------------------
    async workerLoop(token) {
      while (this.isRunning(token)) {
        const task = this.takeTask();
        if (!task) {
          if (this.job.meta.scan.done && !this.inflight && !this.deferred.length && !this.adoptQueue.length && !this.zipActive) return;
          await this.waitForWork();
          continue;
        }
        this.inflight++;
        try {
          await this.processTask(task);
        } catch (e) {
          console.error('[YDD] ошибка обработки файла', e);
          this.unclaim(task.idx);
        } finally {
          this.inflight--;
          this.notifyWork();
          this.emit();
        }
      }
    }

    takeTask() {
      if (this.adoptQueue.length) return this.adoptQueue.shift();
      // Типы файлов ещё не выбраны — только ищем файлы, ничего не скачиваем.
      if (this.needsFilter()) return null;
      // Две части архива ждут сохранения — не набираем новые, чтобы не переполнить временное место.
      if (this.zipQueue.length >= 2) return null;
      const now = Date.now();
      const ready = this.deferred.findIndex((d) => d.notBefore <= now);
      if (ready >= 0) return this.deferred.splice(ready, 1)[0];
      const idx = this.nextPendingIndex();
      if (idx < 0) return null;
      this.claimed.add(idx);
      return { idx, attempt: 1 };
    }

    nextPendingIndex() {
      const st = this.job.st;
      for (let i = this.cursor; i < st.length; i++) {
        if (st[i] === ST.PENDING && !this.claimed.has(i)) {
          this.cursor = i;
          return i;
        }
      }
      this.cursor = st.length;
      return -1;
    }

    unclaim(idx) {
      this.claimed.delete(idx);
      if (idx < this.cursor) this.cursor = idx;
    }

    waitForWork() {
      return new Promise((resolve) => {
        const next = this.deferred.reduce((m, d) => Math.min(m, d.notBefore), Infinity);
        const ms = Math.max(250, Math.min(5000, next - Date.now()));
        let timer = null;
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(done, ms);
        this.waiters.push(done);
      });
    }

    notifyWork() {
      const waiters = this.waiters;
      this.waiters = [];
      waiters.forEach((fn) => fn());
    }

    wakeAll() {
      this.notifyWork();
    }

    canStartDownload() {
      return !!this.job && this.job.meta.phase === 'running';
    }

    async processTask(task) {
      const idx = task.idx;
      const remote = this.job.files[idx][0];
      const view = { idx, name: basename(remote), path: remote, received: 0, total: this.job.files[idx][2], stage: 'link' };
      this.active.set(idx, view);
      this.emit();
      try {
        // await обязателен: иначе finally сработает раньше, чем закончатся повторы и запасные варианты.
        await this.runTask(task, view);
      } finally {
        this.active.delete(idx);
      }
    }

    async runTask(task, view) {
      const job = this.job;
      const idx = task.idx;
      const [remote, local] = job.files[idx];
      if (task.downloadId != null) {
        // Загрузка, начатая до перезагрузки страницы: просто дожидаемся её.
        view.stage = 'download';
        job.meta.active[idx] = task.downloadId;
        const adopted = await this.monitor.track(task.downloadId, this.trackOptions(idx, view, false));
        if (this.job !== job) return;
        delete job.meta.active[idx];
        this.markMeta();
        if (adopted.ok) return this.finish(idx, ST.DONE);
        delete task.downloadId;
        return this.afterFailure(task, adopted);
      }
      let url;
      try {
        url = await this.source.getFileUrl(remote);
      } catch (e) {
        if (this.job !== job) return;
        if (e.fatal) {
          this.unclaim(idx);
          return this.block(e);
        }
        if (e.kind === 'notfound') return this.finish(idx, ST.FAILED, t('note.gone'));
        return this.afterFailure(task, { ok: false, kind: 'link', message: e.message });
      }
      if (this.job !== job) return;
      if (!this.canStartDownload()) return this.unclaim(idx);
      view.stage = 'download';
      const result = await this.download(idx, url, local, false, view);
      if (this.job !== job) return;
      if (result.ok) return this.finish(idx, ST.DONE, result.note);
      return this.afterFailure(task, result);
    }

    async afterFailure(task, result) {
      const idx = task.idx;
      switch (result.kind) {
        case 'stopped':
          return this.unclaim(idx);
        case 'danger':
          return this.finish(
            idx,
            ST.CONFIRM,
            t('note.dangerous')
          );
        case 'nospace':
          this.unclaim(idx);
          return this.block({ kind: 'nospace', message: t('err.noSpace') });
        case 'destauth':
          this.unclaim(idx);
          return this.block({ kind: 'dest', message: t('err.destFix', { message: result.message }) });
        case 'destfull':
          this.unclaim(idx);
          return this.block({ kind: 'dest', message: t('err.destFree', { message: result.message }) });
        case 'zipspace':
          this.unclaim(idx);
          return this.block({
            kind: 'nospace',
            message: t('err.zipSpace', { message: result.message }),
          });
        case 'canceled':
          if (!this.canStartDownload()) return this.unclaim(idx);
          return this.finish(idx, ST.FAILED, result.message);
        case 'local':
          return this.finish(idx, ST.FAILED, result.message);
        default:
          break;
      }
      // Мёртвые узлы хранения обычно не оживают за минуту: за один проход пробуем один раз,
      // остальное — кнопкой «Повторить неудачные».
      const maxAttempts = result.kind === 'stalled' ? 1 : 2;
      if (task.attempt < maxAttempts && this.canStartDownload()) {
        this.deferred.push({ idx, attempt: task.attempt + 1, notBefore: Date.now() + this.timing.retryDelayMs * task.attempt });
        return;
      }
      if (!this.canStartDownload()) return this.unclaim(idx);
      const job = this.job;
      const fallback = await this.fallback(idx, result);
      if (fallback || this.job !== job) return;
      if (!this.canStartDownload()) return this.unclaim(idx);
      this.finish(idx, ST.FAILED, result.message);
    }

    /** Для фото: прямая ссылка ORIGINAL из свойств файла, затем — самое большое превью. */
    async fallback(idx, cause) {
      const [remote, local, , media] = this.job.files[idx];
      if (!isImage(media, remote)) return false;
      let info;
      try {
        info = await this.source.info(remote);
      } catch (e) {
        if (e.fatal) {
          this.unclaim(idx);
          this.block(e);
          return true;
        }
        return false;
      }
      const view = this.active.get(idx) || { idx, name: basename(remote), received: 0, total: null };
      const original = originalFromSizes(info.sizes);
      if (original && this.canStartDownload()) {
        view.stage = 'download';
        const r = await this.download(idx, original, local, false, view);
        if (r.ok) {
          this.finish(idx, ST.DONE, r.note);
          return true;
        }
        if (r.kind === 'stopped') {
          this.unclaim(idx);
          return true;
        }
      }
      if (!this.job.meta.opt.preview) return false;
      const preview = pickPreview(info.sizes);
      if (!preview || !this.canStartDownload()) return false;
      view.stage = 'preview';
      view.received = 0;
      view.total = null;
      const r = await this.download(idx, preview.url, this.previewOf(local), true, view);
      if (r.ok) {
        this.finish(idx, ST.PREVIEW, t('note.preview', { cause: cause.message, name: preview.name }));
        return true;
      }
      if (r.kind === 'stopped') {
        this.unclaim(idx);
        return true;
      }
      return false;
    }

    trackOptions(idx, view, preview) {
      const slow = (this.job.meta.pass || 1) > 1 ? this.timing.slowFactor : 1;
      return {
        firstByteMs: this.timing.firstByteMs * slow,
        stallMs: this.timing.stallMs * slow,
        onProgress: (item) => {
          view.received = item.bytesReceived || 0;
          if (item.totalBytes > 0) view.total = item.totalBytes;
          view.busy = !!item.busy;
          this.emit();
        },
        onSaveAs: () => {
          this.saveAsSuspected = true;
          this.block({
            kind: 'saveas',
            message: t('err.saveAs'),
          });
        },
        preview,
      };
    }

    startFailure(error) {
      const code = String(error || '');
      if (code === 'NO_RESPONSE') return { ok: false, kind: 'stalled', message: t('err.noResponse') };
      if (/^(SERVER|NETWORK)_[A-Z_]+$/.test(code)) return interruptResult(code);
      if (code === 'FILE_NO_SPACE') return interruptResult(code);
      if (code === 'extension-reloaded') return { ok: false, kind: 'stopped' };
      if (/message port closed|Receiving end does not exist|no-response/i.test(code)) {
        return { ok: false, kind: 'network', message: t('err.bgSilent') };
      }
      return { ok: false, kind: 'local', message: t('err.downloadStart', { error: code || t('err.unknown') }) };
    }

    /** Перенос в облако или на сервер: файл идёт через offscreen-документ, минуя диск компьютера. */
    async transfer(idx, url, local, preview, view, headers) {
      const opt = this.job.meta.opt;
      const res = await this.bg.startTransfer({
        url,
        filename: joinPath(opt.root, local),
        headers,
        size: preview ? 0 : this.job.files[idx][2] || 0,
      });
      if (!res.ok) {
        if (res.error === 'extension-reloaded') return { ok: false, kind: 'stopped' };
        if (res.error === 'DEST_CONFIG') return interruptResult('DEST_CONFIG', t('err.destNotConnected'));
        return { ok: false, kind: 'network', message: t('err.transferStart', { error: res.error || t('err.unknown') }) };
      }
      this.job.meta.active[idx] = res.id;
      this.markMeta();
      const result = await this.monitor.track(res.id, this.trackOptions(idx, view, preview));
      delete this.job.meta.active[idx];
      this.markMeta();
      if (result.ok && !preview) {
        const expected = this.job.files[idx][2];
        if (expected != null && result.bytes != null && result.bytes !== expected) {
          result.note = t('note.sizeDiffers', { got: result.bytes, expected });
        }
      }
      return result;
    }

    // --- ZIP-архив ------------------------------------------------------------------
    // Файлы скачивает и складывает в архив offscreen-документ. Готовая часть (по размеру
    // или в конце) сохраняется одной загрузкой браузера. Пока часть не сохранена, её файлы
    // имеют статус ZIPPED: если браузер перезапустят, они скачаются заново.

    /** Скачивает файл в открытую часть архива. */
    async zipAdd(idx, url, local, preview, view, headers) {
      const meta = this.job.meta;
      const dest = meta.opt.dest;
      const z = meta.zip;
      const file = this.job.files[idx];
      const res = await this.bg.startZip({
        jobId: meta.id,
        idx,
        url,
        headers,
        path: local, // для превью имя уже с пометкой «(превью)»
        size: preview ? 0 : file[2] || 0,
        mtime: file[4] ? file[4] * 1000 : 0,
        packAll: !!dest.packAll,
        partBytes: this.timing.zipPartBytes || Math.max(64, Number(dest.partMB) || ZIP_PART_MB) * 1024 * 1024,
        firstPart: z.next,
      });
      if (!res.ok) {
        if (res.error === 'extension-reloaded') return { ok: false, kind: 'stopped' };
        return { ok: false, kind: 'network', message: t('err.zipStart', { error: res.error || t('err.unknown') }) };
      }
      meta.active[idx] = res.id;
      this.markMeta();
      const result = await this.monitor.track(res.id, this.trackOptions(idx, view, preview));
      delete meta.active[idx];
      this.markMeta();
      if (result.ok) {
        if (result.part) z.next = Math.max(z.next, result.part + 1);
        this.zipEnqueue(result.sealed);
        if (!preview && file[2] != null && result.bytes != null && result.bytes !== file[2]) {
          result.note = t('note.sizeDiffers', { got: result.bytes, expected: file[2] });
        }
      }
      return result;
    }

    /** Ставит закрытые части архива в очередь на сохранение. */
    zipEnqueue(list) {
      const z = this.job.meta.zip;
      for (const p of list || []) {
        if (!p || !p.n || this.zipQueue.some((q) => q.n === p.n)) continue;
        if ((z.saving && z.saving.n === p.n) || (this.zipAdopt && this.zipAdopt.n === p.n)) continue;
        if (z.parts.some((x) => x.n === p.n)) continue;
        this.zipQueue.push({ n: p.n, final: !!p.final });
      }
      this.zipQueue.sort((a, b) => a.n - b.n);
      if (this.zipQueue.length) this.notifyWork();
    }

    /** Возвращает в очередь файлы из несохранённых частей, которых больше нет. */
    zipRevert(keep, only, since) {
      const { st, meta } = this.job;
      let lost = 0;
      const list = only || st.keys();
      for (const i of list) {
        // Файл лёг в архив уже после запроса состояния — он в открытой части, не трогаем.
        if (since != null && (this.zipMarks.get(i) || 0) > since) continue;
        if (isZipped(st[i]) && !(keep && keep.has(i))) {
          this.setStatus(i, ST.PENDING);
          delete meta.notes[i];
          lost++;
        }
      }
      if (lost) this.cursor = 0;
      return lost;
    }

    /**
     * Сверяет задание с частями архива в offscreen-документе. Нужна после перезагрузки страницы
     * (части целы) и после перезапуска браузера (несохранённые части пропали).
     */
    async zipSync(token, { afterSeal = false } = {}) {
      const job = this.job;
      const meta = job.meta;
      const z = meta.zip;
      const since = this.zipSeq;
      const res = await this.bg.zipState(meta.id);
      if (this.job !== job) return;
      if (!res || !res.ok) throw new Error((res && res.error) || t('err.noAnswer'));
      const keep = new Set();
      const queue = [];
      if (res.exists) {
        // Сразу после закрытия последней части открытой быть не должно — её файлы не ждём.
        if (res.open && !afterSeal) res.open.entries.forEach((i) => keep.add(i));
        for (const p of res.sealed || []) {
          p.entries.forEach((i) => keep.add(i));
          queue.push(p);
        }
        z.next = Math.max(z.next || 1, res.next || 1);
      } else {
        // Несохранённые части пропали вместе с браузером — их номера можно занять снова.
        z.next = z.parts.reduce((m, p) => Math.max(m, p.n + 1), 1);
      }
      if (z.saving) {
        const s = z.saving;
        const st = await this.bg.status([s.id]);
        if (this.job !== job) return;
        const item = st && st.ok ? st.items[s.id] : null;
        if (item && item.state === 'complete') this.zipDone(s);
        else if (item && item.state === 'in_progress') {
          s.entries.forEach((i) => keep.add(i));
          this.zipAdopt = s;
        } else {
          // Сохранение прервалось. Если часть ещё в памяти браузера, она снова в очереди (sealed).
          z.saving = null;
          if (item) this.bg.erase(s.id);
        }
      }
      this.zipQueue = [];
      this.zipEnqueue(queue);
      // Метки есть только у файлов, добавленных в этом сеансе, — после перезапуска браузера их нет.
      this.zipRevert(keep, null, since);
      this.markMeta();
    }

    /** Сохраняет закрытые части архива и закрывает последнюю, когда все файлы скачаны. */
    async zipLoop(token) {
      this.zipActive = true;
      try {
        while (this.isRunning(token)) {
          if (this.zipAdopt) {
            const s = this.zipAdopt;
            this.zipAdopt = null;
            await this.zipTrack(token, s);
            continue;
          }
          if (this.zipQueue.length) {
            await this.zipSave(token, this.zipQueue[0]);
            continue;
          }
          const c = this.counts;
          const idle =
            this.job.meta.scan.done && !c[ST.PENDING] && !this.claimed.size && !this.inflight && !this.deferred.length && !this.adoptQueue.length;
          if (idle && (c[ST.ZIPPED] || c[ST.ZIPPED_PREVIEW])) {
            const res = await this.bg.zipSeal(this.job.meta.id);
            if (!this.isRunning(token)) return;
            if (!res || !res.ok) return this.block({ kind: 'zip', message: t('err.zipSealFailed', { error: (res && res.error) || t('err.noAnswer') }) });
            this.zipEnqueue(res.sealed);
            // Части не нашлось — её потеряли вместе с браузером: эти файлы скачаем заново.
            if (!this.zipQueue.length) await this.zipSync(token, { afterSeal: true });
            continue;
          }
          if (idle) return;
          await this.waitForWork();
        }
      } finally {
        this.zipActive = false;
        this.notifyWork();
      }
    }

    async zipSave(token, part) {
      const job = this.job;
      const meta = job.meta;
      let filename = fitPath(meta.opt.root, zipPartName(meta.opt.dest.name, part.n, part.final && part.n === 1, this.names().part), sanitizeComponent(this.names().longPaths));
      let res = await this.bg.zipSave({ jobId: meta.id, n: part.n, filename });
      if (!res.ok && /filename/i.test(res.error || '')) {
        filename = strictPath(filename);
        res = await this.bg.zipSave({ jobId: meta.id, n: part.n, filename });
      }
      if (this.job !== job) return;
      this.zipQueue = this.zipQueue.filter((q) => q.n !== part.n);
      if (!res.ok) {
        if (res.error === 'ZIP_LOST') return this.zipSync(token);
        const r = this.startFailure(res.error);
        if (r.kind === 'stopped') return;
        return this.block({ kind: 'zip', message: t('err.zipFailed', { error: r.message }) });
      }
      meta.zip.saving = { n: part.n, id: res.id, file: filename, bytes: res.bytes || 0, entries: res.entries || [] };
      this.markMeta();
      await this.flush();
      return this.zipTrack(token, meta.zip.saving);
    }

    /** Ждёт, пока браузер запишет часть архива на диск. */
    async zipTrack(token, s) {
      const job = this.job;
      const key = 'zip:' + s.n;
      const view = { idx: key, name: basename(s.file), path: s.file, received: 0, total: s.bytes || null, stage: 'zip' };
      this.active.set(key, view);
      this.emit();
      let r;
      try {
        r = await this.monitor.track(s.id, {
          firstByteMs: ZIP_SAVE_STALL_MS,
          stallMs: ZIP_SAVE_STALL_MS,
          waitDanger: true,
          onProgress: (item) => {
            view.received = item.bytesReceived || 0;
            if (item.totalBytes > 0) view.total = item.totalBytes;
            if (!OK_DANGER.has(item.danger)) view.stage = 'zip-confirm';
            else if (item.filename || view.stage !== 'zip-saveas') view.stage = 'zip';
            this.emit();
          },
          // Браузер спрашивает, куда сохранить архив, — это нормально, ждём пользователя.
          onSaveAs: () => {
            view.stage = 'zip-saveas';
            this.emit();
          },
        });
      } finally {
        this.active.delete(key);
      }
      if (this.job !== job) return;
      const z = job.meta.zip;
      if (z.saving && z.saving.n === s.n) z.saving = null;
      this.markMeta();
      if (r.ok) return this.zipDone(s);
      if (r.kind === 'stopped') return; // часть цела, сохраним после «Продолжить»
      this.bg.erase(s.id);
      if (r.kind === 'nospace') {
        return this.block({ kind: 'nospace', message: t('err.zipNoSpace') });
      }
      z.fails = z.fails || {};
      z.fails[s.n] = (z.fails[s.n] || 0) + 1;
      if (z.fails[s.n] < 2) {
        return this.block({ kind: 'zip', message: t('err.zipRetry', { error: r.message }) });
      }
      // Вторая неудача подряд: часть, видимо, повреждена во временном хранилище — собираем её заново.
      this.bg.zipRelease(job.meta.id, s.n);
      this.zipRevert(null, s.entries);
      return this.block({
        kind: 'zip',
        message: t('err.zipBroken', { error: r.message }),
      });
    }

    /** Часть архива записана на компьютер: её файлы окончательно сохранены. */
    zipDone(s) {
      const { st, meta } = this.job;
      const z = meta.zip;
      for (const i of s.entries || []) {
        if (st[i] === ST.ZIPPED) this.setStatus(i, ST.DONE);
        else if (st[i] === ST.ZIPPED_PREVIEW) this.setStatus(i, ST.PREVIEW);
      }
      if (!z.parts.some((p) => p.n === s.n)) z.parts.push({ n: s.n, file: s.file, bytes: s.bytes || 0, count: (s.entries || []).length });
      if (z.saving && z.saving.n === s.n) z.saving = null;
      this.zipQueue = this.zipQueue.filter((q) => q.n !== s.n);
      this.bg.zipRelease(meta.id, s.n);
      this.markMeta();
      this.notifyWork();
      this.emit();
    }

    async download(idx, url, local, preview, view) {
      if (!isYandexUrl(url)) return { ok: false, kind: 'local', message: t('err.badUrl') };
      const opt = this.job.meta.opt;
      const headers = preview ? [{ name: 'Accept', value: 'image/jpeg,image/png;q=0.9,image/*;q=0.8' }] : null;
      if (opt.dest && opt.dest.type === 'zip') return this.zipAdd(idx, url, local, preview, view, headers);
      if (opt.dest && opt.dest.type && opt.dest.type !== 'local') return this.transfer(idx, url, local, preview, view, headers);
      let filename = fitPath(opt.root, local, sanitizeComponent(this.names().longPaths));
      const slow = (this.job.meta.pass || 1) > 1 ? this.timing.slowFactor : 1;
      const timeoutMs = this.timing.startMs * slow;
      let res = await this.bg.startDownload({ url, filename, headers, timeoutMs });
      if (!res.ok && /filename/i.test(res.error || '')) {
        filename = strictPath(filename);
        res = await this.bg.startDownload({ url, filename, headers, timeoutMs });
      }
      if (!res.ok) return this.startFailure(res.error);
      this.job.meta.active[idx] = res.id;
      this.markMeta();
      let result = await this.monitor.track(res.id, this.trackOptions(idx, view, preview));
      delete this.job.meta.active[idx];
      this.markMeta();
      if (opt.eraseHistory && result.kind !== 'danger') this.bg.erase(res.id);
      if (result.kind === 'toolong') {
        const name = local.split('/').pop();
        const short = joinPath(opt.root, sanitizeComponent(this.names().longPaths), truncateComponent(shortHash(local) + '_' + sanitizeComponent(name), 80));
        res = await this.bg.startDownload({ url, filename: short, headers, timeoutMs });
        if (!res.ok) return this.startFailure(res.error);
        this.job.meta.active[idx] = res.id;
        result = await this.monitor.track(res.id, this.trackOptions(idx, view, preview));
        delete this.job.meta.active[idx];
        this.markMeta();
        if (opt.eraseHistory && result.kind !== 'danger') this.bg.erase(res.id);
        if (result.ok) result.note = t('note.longPath', { path: short });
      }
      if (result.ok && !preview) {
        const expected = this.job.files[idx][2];
        if (expected != null && result.bytes != null && result.bytes !== expected) {
          result.note = t('note.sizeDiffers', { got: result.bytes, expected });
        }
      }
      return result;
    }

    finish(idx, status, note) {
      const meta = this.job.meta;
      if (this.isZip()) {
        // В архиве файл считается сохранённым, только когда его часть записана на компьютер.
        if (status === ST.DONE) status = ST.ZIPPED;
        else if (status === ST.PREVIEW) status = ST.ZIPPED_PREVIEW;
        if (isZipped(status)) this.zipMarks.set(idx, ++this.zipSeq);
      }
      if (status === ST.FAILED) meta.errors[idx] = note || t('err.default');
      else delete meta.errors[idx];
      if (note && status !== ST.FAILED) meta.notes[idx] = note;
      else if (!note) delete meta.notes[idx];
      this.setStatus(idx, status);
      this.claimed.delete(idx);
      this.markMeta();
    }

    setStatus(idx, status) {
      const st = this.job.st;
      const prev = st[idx];
      if (prev === status) return;
      this.counts[prev] = Math.max(0, (this.counts[prev] || 0) - 1);
      this.counts[status] = (this.counts[status] || 0) + 1;
      const size = this.job.files[idx][2] || 0;
      if (countsBytes(prev)) this.bytesDone -= size;
      if (countsBytes(status)) this.bytesDone += size;
      if (prev === ST.EXCLUDED) this.excludedBytes -= size;
      if (status === ST.EXCLUDED) this.excludedBytes += size;
      st[idx] = status;
      this.dirtySt.add(Math.floor(idx / CHUNK));
      this.scheduleFlush();
      this.emit();
    }

    // --- Сохранение -------------------------------------------------------------
    markMeta() {
      this.dirtyMeta = true;
      this.scheduleFlush();
    }

    scheduleFlush() {
      if (this.flushTimer) return;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.timing.flushMs);
    }

    async flush(force) {
      if (!this.job) return;
      if (!force && !this.dirtyMeta && !this.dirtyFiles.size && !this.dirtySt.size) return;
      const fileChunks = [...this.dirtyFiles];
      const statusChunks = [...this.dirtySt];
      this.dirtyFiles.clear();
      this.dirtySt.clear();
      this.dirtyMeta = false;
      const job = this.job;
      job.meta.updatedAt = Date.now();
      job.meta.fileCount = job.files.length;
      try {
        await this.store.save(job, fileChunks, statusChunks);
        this.storageError = null;
      } catch (e) {
        if (job !== this.job) return;
        fileChunks.forEach((k) => this.dirtyFiles.add(k));
        statusChunks.forEach((k) => this.dirtySt.add(k));
        this.dirtyMeta = true;
        this.storageError = e && e.message;
        this.scheduleFlush();
      }
    }

    // --- Для интерфейса -----------------------------------------------------------
    snapshot() {
      if (!this.job) return { job: null, blocked: this.blocked };
      const meta = this.job.meta;
      const c = this.counts;
      const active = [...this.active.values()].map((a) => Object.assign({}, a));
      const inProgress = active.reduce((sum, a) => sum + (a.stage === 'download' ? a.received || 0 : 0), 0);
      this.speed.add(this.bytesDone + inProgress);
      const speed = meta.phase === 'running' ? this.speed.rate() : 0;
      const includedBytes = Math.max(0, meta.totalBytes - this.excludedBytes);
      const remainingBytes = Math.max(0, includedBytes - this.bytesDone - inProgress);
      return {
        job: {
          id: meta.id,
          phase: meta.phase,
          scopeLabel: meta.scope.label,
          scopeType: meta.scope.type,
          root: meta.opt.root,
          opt: meta.opt,
          dest: meta.opt.dest && meta.opt.dest.type !== 'local' ? meta.opt.dest : null,
          pass: meta.pass || 1,
          createdAt: meta.createdAt,
          finishedAt: meta.finishedAt || null,
        },
        scanning: !meta.scan.done,
        dirs: meta.scan.dirs,
        scanErrors: meta.scan.errors.map((e) => ({ path: e.path, msg: e.msg })),
        unlim: {
          state: meta.scan.unlim.state,
          found: meta.scan.unlim.found || 0,
          active: meta.scan.unlim.state === 'pending' && !meta.scan.stack.length && meta.phase === 'running',
        },
        // Без файлов, которые не подходят под выбранные типы.
        total: meta.fileCount - (c[ST.EXCLUDED] || 0),
        totalBytes: includedBytes,
        found: meta.fileCount,
        excluded: c[ST.EXCLUDED] || 0,
        filter: meta.filter ? { pending: !!meta.filter.pending, exts: meta.filter.exts || [] } : null,
        typeCount: this.types.size,
        bytesDone: this.bytesDone + inProgress,
        reused: meta.reused || 0,
        done: c[ST.DONE] || 0,
        preview: c[ST.PREVIEW] || 0,
        failed: c[ST.FAILED] || 0,
        confirm: c[ST.CONFIRM] || 0,
        skipped: c[ST.SKIPPED] || 0,
        pending: c[ST.PENDING] || 0,
        zipped: (c[ST.ZIPPED] || 0) + (c[ST.ZIPPED_PREVIEW] || 0),
        zip: meta.zip
          ? {
              parts: meta.zip.parts.length,
              bytes: meta.zip.parts.reduce((sum, p) => sum + (p.bytes || 0), 0),
              files: meta.zip.parts.map((p) => basename(p.file)),
              waiting: this.zipQueue.length + (meta.zip.saving ? 1 : 0),
            }
          : null,
        active,
        speed,
        eta: !meta.scan.done || speed <= 0 ? 0 : remainingBytes / speed,
        blocked: this.blocked,
        rateLimitedUntil: this.rateLimitedUntil > Date.now() ? this.rateLimitedUntil : 0,
        storageError: this.storageError || null,
        recentErrors: this.recentErrors(5),
      };
    }

    recentErrors(limit) {
      const out = [];
      const errors = this.job.meta.errors;
      const keys = Object.keys(errors);
      for (let i = keys.length - 1; i >= 0 && out.length < limit; i--) {
        const idx = Number(keys[i]);
        out.push({ name: basename(this.job.files[idx][0]), msg: errors[keys[i]] });
      }
      return out;
    }

    buildReport() {
      const { files, st, meta } = this.job;
      const label = {
        [ST.DONE]: t('report.done'),
        [ST.PREVIEW]: t('report.preview'),
        [ST.FAILED]: t('report.failed'),
        [ST.CONFIRM]: t('report.confirm'),
        [ST.SKIPPED]: t('report.skipped'),
        [ST.PENDING]: t('report.pending'),
        [ST.ZIPPED]: t('report.zipped'),
        [ST.ZIPPED_PREVIEW]: t('report.zippedPreview'),
      };
      const remote = meta.opt.dest && meta.opt.dest.type && meta.opt.dest.type !== 'local' ? meta.opt.dest.label : '';
      const rows = [[t('report.path'), t('report.result'), remote ? t('report.savedTo') : t('report.localFile'), t('report.details')]];
      for (let i = 0; i < files.length; i++) {
        const note = meta.errors[i] || meta.notes[i] || '';
        if ((st[i] === ST.DONE && !note) || st[i] === ST.EXCLUDED) continue;
        const inZip = meta.opt.dest && meta.opt.dest.type === 'zip';
        const preview = st[i] === ST.PREVIEW || st[i] === ST.ZIPPED_PREVIEW;
        const local = preview ? this.previewOf(files[i][1]) : files[i][1];
        const saved = inZip ? local : joinPath(meta.opt.root, local);
        rows.push([files[i][0], label[st[i]] || st[i], remote ? `${remote} / ${saved}` : saved, note]);
      }
      for (const e of meta.scan.errors) rows.push([e.path, t('report.dirUnread'), '', e.msg]);
      if (meta.scan.unlim.state === 'failed') rows.push(['/photounlim', t('report.unlimUnread'), '', meta.scan.unlim.msg || '']);
      return '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
    }
  }

  Object.assign(YDD, { Engine, DownloadMonitor, SpeedMeter, DEFAULT_OPTIONS, DEFAULT_TIMING, interruptResult });
})(typeof globalThis !== 'undefined' ? globalThis : this);
