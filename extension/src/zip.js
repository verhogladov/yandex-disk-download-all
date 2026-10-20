/*
 * Сборка ZIP-архива прямо в браузере: файлы добавляются по мере скачивания,
 * архив делится на части. Формат — обычный ZIP с UTF-8 именами; для файлов
 * и частей больше 4 ГБ — ZIP64. Документы сжимаются (deflate), фото и видео
 * кладутся как есть: они уже сжаты.
 */
(function (root) {
  'use strict';
  const YDD = (root.YDD = root.YDD || {});

  // --- CRC-32 ---------------------------------------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32Update(crc, bytes) {
    let c = ~crc >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  }

  // Уже сжатые форматы: повторное сжатие почти ничего не даёт, только тратит время.
  const STORED = /\.(jpe?g|png|gif|webp|heic|heif|avif|mp4|m4v|mov|avi|mkv|webm|3gp|mts|m2ts|mp3|m4a|aac|ogg|opus|flac|zip|rar|7z|gz|tgz|bz2|xz|zst|docx|xlsx|pptx|odt|ods|odp|epub|apk|ipa|dmg|pdf)$/i;

  function shouldCompress(name) {
    return !STORED.test(name || '');
  }

  function dosDateTime(date) {
    const d = date instanceof Date && !isNaN(date) ? date : new Date();
    const year = Math.min(2107, Math.max(1980, d.getFullYear()));
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  const MAX32 = 0xffffffff;
  const encoder = new TextEncoder();

  function unixTime(date) {
    const ms = date instanceof Date ? date.getTime() : NaN;
    return Number.isFinite(ms) && ms > 0 ? Math.min(MAX32, Math.floor(ms / 1000)) : 0;
  }

  /** Поле «extended timestamp» (0x5455): время в UTC, чтобы дата не зависела от часового пояса. */
  function timestampField(unix) {
    return unix ? fields([[2, 0x5455], [2, 5], [1, 1], [4, unix]]) : new Uint8Array(0);
  }

  /** Записывает little-endian поля в буфер по порядку. */
  function fields(spec) {
    const size = spec.reduce((s, [bytes]) => s + bytes, 0);
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    let pos = 0;
    for (const [bytes, value] of spec) {
      if (bytes === 1) view.setUint8(pos, value);
      else if (bytes === 2) view.setUint16(pos, value, true);
      else if (bytes === 4) view.setUint32(pos, value >>> 0, true);
      else if (bytes === 8) view.setBigUint64(pos, BigInt(value), true);
      pos += bytes;
    }
    return buf;
  }

  function concatBytes(...parts) {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let pos = 0;
    for (const p of parts) {
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  }

  /** Сжимает Blob в «сырой» deflate средствами браузера. */
  async function deflateBlob(blob) {
    const stream = blob.stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Response(stream).blob();
  }

  /**
   * Готовит запись для архива из потока байтов файла: считает CRC, при необходимости сжимает.
   * chunks — асинхронный итератор Uint8Array.
   */
  async function prepareEntry(name, chunks, { mtime, compress = shouldCompress(name), onChunk, onCompress } = {}) {
    let crc = 0;
    let size = 0;
    const parts = [];
    let pending = [];
    let pendingSize = 0;
    for await (const chunk of chunks) {
      crc = crc32Update(crc, chunk);
      size += chunk.byteLength;
      pending.push(chunk);
      pendingSize += chunk.byteLength;
      if (onChunk) onChunk(chunk.byteLength);
      if (pendingSize >= 8 << 20) {
        // Крупными блоками в Blob: так большой файл не держится целиком в памяти скрипта.
        parts.push(new Blob(pending));
        pending = [];
        pendingSize = 0;
      }
    }
    if (pending.length) parts.push(new Blob(pending));
    const raw = new Blob(parts);
    let data = raw;
    let method = 0;
    if (compress && size > 0) {
      if (onCompress) onCompress(true);
      try {
        const packed = await deflateBlob(raw);
        // Сжатое оставляем, только если оно действительно меньше.
        if (packed.size < raw.size) {
          data = packed;
          method = 8;
        }
      } finally {
        if (onCompress) onCompress(false);
      }
    }
    return { name, crc, size, data, method, mtime: mtime ? new Date(mtime) : new Date() };
  }

  /** Одна часть архива. Записи добавляются целиком: локальный заголовок + данные. */
  class ZipVolume {
    constructor({ forceZip64 = false } = {}) {
      this.parts = [];
      this.entries = [];
      this.offset = 0;
      this.forceZip64 = forceZip64;
    }

    get size() {
      return this.offset;
    }

    add(entry) {
      const nameBytes = encoder.encode(entry.name);
      const { time, date } = dosDateTime(entry.mtime);
      const unix = unixTime(entry.mtime);
      const zip64 = this.forceZip64 || entry.size >= MAX32 || entry.data.size >= MAX32;
      const extra = concatBytes(
        zip64 ? fields([[2, 0x0001], [2, 16], [8, entry.size], [8, entry.data.size]]) : new Uint8Array(0),
        timestampField(unix)
      );
      const header = concatBytes(
        fields([
          [4, 0x04034b50],
          [2, zip64 ? 45 : 20],
          [2, 0x0800], // имена в UTF-8
          [2, entry.method],
          [2, time],
          [2, date],
          [4, entry.crc],
          [4, zip64 ? MAX32 : entry.data.size],
          [4, zip64 ? MAX32 : entry.size],
          [2, nameBytes.length],
          [2, extra.length],
        ]),
        nameBytes,
        extra
      );
      this.entries.push({ nameBytes, time, date, unix, crc: entry.crc, size: entry.size, packed: entry.data.size, method: entry.method, offset: this.offset });
      this.parts.push(header, entry.data);
      this.offset += header.length + entry.data.size;
    }

    /** Центральный каталог и конец архива. Возвращает готовый Blob. */
    finish() {
      const cdStart = this.offset;
      const cd = [];
      for (const e of this.entries) {
        const needSizes = this.forceZip64 || e.size >= MAX32 || e.packed >= MAX32;
        const needOffset = this.forceZip64 || e.offset >= MAX32;
        const extraFields = [];
        if (needSizes) extraFields.push([8, e.size], [8, e.packed]);
        if (needOffset) extraFields.push([8, e.offset]);
        const extra = concatBytes(
          extraFields.length ? fields([[2, 0x0001], [2, extraFields.length * 8], ...extraFields]) : new Uint8Array(0),
          timestampField(e.unix)
        );
        const zip64 = extraFields.length > 0;
        cd.push(
          concatBytes(
            fields([
              [4, 0x02014b50],
              [2, zip64 ? 45 : 20],
              [2, zip64 ? 45 : 20],
              [2, 0x0800],
              [2, e.method],
              [2, e.time],
              [2, e.date],
              [4, e.crc],
              [4, needSizes ? MAX32 : e.packed],
              [4, needSizes ? MAX32 : e.size],
              [2, e.nameBytes.length],
              [2, extra.length],
              [2, 0],
              [2, 0],
              [2, 0],
              [4, 0],
              [4, needOffset ? MAX32 : e.offset],
            ]),
            e.nameBytes,
            extra
          )
        );
      }
      const cdSize = cd.reduce((s, b) => s + b.length, 0);
      const count = this.entries.length;
      const tail = [];
      const zip64End = this.forceZip64 || count >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
      if (zip64End) {
        const endOffset = cdStart + cdSize;
        tail.push(
          fields([
            [4, 0x06064b50],
            [8, 44],
            [2, 45],
            [2, 45],
            [4, 0],
            [4, 0],
            [8, count],
            [8, count],
            [8, cdSize],
            [8, cdStart],
          ]),
          fields([[4, 0x07064b50], [4, 0], [8, endOffset], [4, 1]])
        );
      }
      tail.push(
        fields([
          [4, 0x06054b50],
          [2, 0],
          [2, 0],
          [2, zip64End ? 0xffff : count],
          [2, zip64End ? 0xffff : count],
          [4, zip64End ? MAX32 : cdSize],
          [4, zip64End ? MAX32 : cdStart],
          [2, 0],
        ])
      );
      return new Blob([...this.parts, ...cd, ...tail], { type: 'application/zip' });
    }
  }

  Object.assign(YDD, { crc32Update, shouldCompress, prepareEntry, ZipVolume, dosDateTime });
  if (typeof module !== 'undefined' && module.exports) module.exports = YDD;
})(typeof globalThis !== 'undefined' ? globalThis : this);
