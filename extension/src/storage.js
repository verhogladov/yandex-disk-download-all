/*
 * Хранение заданий в chrome.storage.local. Список файлов пишется частями
 * по 1000 штук, статусы — строкой по символу на файл: так прогресс сохраняется
 * часто и дёшево даже для сотен тысяч файлов.
 */
(function (root) {
  'use strict';
  const YDD = (root.YDD = root.YDD || {});

  const CHUNK = 1000;
  const SETTINGS_KEY = 'ydd:settings';

  const keyMeta = (id) => `ydd:job:${id}:meta`;
  const keyFiles = (id, k) => `ydd:job:${id}:f:${k}`;
  const keyStatus = (id, k) => `ydd:job:${id}:s:${k}`;
  const keyPointer = (account) => `ydd:cur:${account}`;

  class JobStore {
    constructor(area) {
      this.area = area;
    }

    async getPointer(account) {
      const k = keyPointer(account);
      return (await this.area.get(k))[k] || null;
    }

    async setPointer(account, jobId) {
      const k = keyPointer(account);
      if (jobId) await this.area.set({ [k]: jobId });
      else await this.area.remove(k);
    }

    async load(jobId) {
      const meta = (await this.area.get(keyMeta(jobId)))[keyMeta(jobId)];
      if (!meta) return null;
      const chunks = Math.ceil((meta.fileCount || 0) / CHUNK);
      const wanted = [];
      for (let k = 0; k < chunks; k++) wanted.push(keyFiles(jobId, k), keyStatus(jobId, k));
      const data = wanted.length ? await this.area.get(wanted) : {};
      const files = [];
      const st = [];
      for (let k = 0; k < chunks; k++) {
        const part = data[keyFiles(jobId, k)] || [];
        const status = data[keyStatus(jobId, k)] || '';
        for (let i = 0; i < part.length; i++) {
          files.push(part[i]);
          st.push(status[i] || YDD.ST.PENDING);
        }
      }
      meta.fileCount = files.length;
      return { meta, files, st };
    }

    /** Сохраняет метаданные и изменившиеся части списка/статусов. */
    async save(job, fileChunks, statusChunks) {
      const id = job.meta.id;
      const items = { [keyMeta(id)]: job.meta };
      for (const k of fileChunks) items[keyFiles(id, k)] = job.files.slice(k * CHUNK, (k + 1) * CHUNK);
      for (const k of statusChunks) items[keyStatus(id, k)] = job.st.slice(k * CHUNK, (k + 1) * CHUNK).join('');
      await this.area.set(items);
    }

    async remove(jobId) {
      const meta = (await this.area.get(keyMeta(jobId)))[keyMeta(jobId)];
      const keys = [keyMeta(jobId)];
      const chunks = Math.ceil(((meta && meta.fileCount) || 0) / CHUNK) + 1;
      for (let k = 0; k < chunks; k++) keys.push(keyFiles(jobId, k), keyStatus(jobId, k));
      await this.area.remove(keys);
    }

    async getSettings() {
      return (await this.area.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
    }

    async setSettings(settings) {
      await this.area.set({ [SETTINGS_KEY]: settings });
    }
  }

  Object.assign(YDD, { JobStore, CHUNK });
})(typeof globalThis !== 'undefined' ? globalThis : this);
