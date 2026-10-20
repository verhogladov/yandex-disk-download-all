/*
 * Яндекс Диск: скачать всё — общие утилиты.
 * Подключается и как content script, и как модуль Node в тестах.
 */
(function (root) {
  'use strict';
  const YDD = (root.YDD = root.YDD || {});

  // Статусы файла в задании (по одному символу на файл — так компактнее хранить).
  const ST = Object.freeze({
    PENDING: '.',
    DONE: 'd', // скачан оригинал
    PREVIEW: 'p', // оригинал недоступен, сохранено превью
    FAILED: 'f',
    SKIPPED: 's', // пустой файл и т. п.
    CONFIRM: 'c', // браузер ждёт подтверждения (опасный тип файла)
    ZIPPED: 'z', // оригинал лежит в части архива, которая ещё не сохранена на компьютер
    ZIPPED_PREVIEW: 'y', // то же для превью
    EXCLUDED: 'x', // не подходит под выбранные типы файлов
  });

  // --- Типы файлов -------------------------------------------------------------
  // Группы для фильтра. Тип файла — его расширение; группа нужна, чтобы показать их по-человечески.
  const TYPE_GROUPS = [
    ['photo', 'Фото и картинки', 'jpg jpeg jpe png gif heic heif webp bmp tif tiff avif svg ico psd cr2 cr3 nef nrw arw srf sr2 dng raf orf rw2 pef srw x3f'],
    ['video', 'Видео', 'mp4 mov avi mkv m4v 3gp 3g2 wmv mts m2ts webm mpg mpeg vob flv ogv'],
    ['audio', 'Музыка и звук', 'mp3 m4a aac flac wav ogg oga opus wma amr aiff aif ape mid midi'],
    ['docs', 'Документы и таблицы', 'pdf doc docx xls xlsx xlsm ppt pptx pps ppsx odt ods odp rtf txt csv md djvu djv epub fb2 mobi pages numbers key xml json html htm'],
    ['archive', 'Архивы', 'zip rar 7z tar gz tgz bz2 xz zst iso dmg cab'],
    ['other', 'Другое', ''],
  ].map(([id, label, exts]) => ({ id, label, exts: new Set(exts.split(' ').filter(Boolean)) }));
  // Если расширение незнакомое — по типу, который определил сам Яндекс. «Документом» Яндекс
  // называет почти всё подряд, поэтому доверяем только фото, видео, звуку и архивам.
  const MEDIA_GROUP = { image: 'photo', video: 'video', audio: 'audio', compressed: 'archive' };

  /** «IMG_0001.JPG» → «jpg»; у «.hidden» и «README» расширения нет — ''. */
  function fileExt(name) {
    const m = /\.([^./\\\s]{1,12})$/.exec(String(name || ''));
    if (!m || m.index === 0) return '';
    return m[1].toLowerCase();
  }

  function typeGroup(ext, mediaType) {
    for (const g of TYPE_GROUPS) if (g.exts.has(ext)) return g.id;
    return MEDIA_GROUP[mediaType] || 'other';
  }

  // --- Имена файлов -------------------------------------------------------
  // chrome.downloads отклоняет путь целиком («Invalid filename»), если хоть один
  // компонент не проходит net::IsSafePortablePathComponent. Повторяем её правила:
  // запрещённые символы, управляющие и форматирующие символы, точки/пробелы/тильды
  // по краям, зарезервированные имена Windows и «опасные» расширения.
  const ILLEGAL_CHAR = /["~*/:<>?\\|\p{Cc}\p{Cf}\p{Cs}]/u;
  const EDGE_CHARS = /[\p{White_Space}.~]/u;
  const STRICT_ALLOWED = /[\p{L}\p{N}\p{M} _.,()[\]{}+=!@#$%^&'-]/u;
  const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|clock\$|conin\$|conout\$)(\.|$)/i;
  const MAGIC_NAMES = new Set(['desktop.ini', 'thumbs.db']);
  const SHELL_EXT = /\.(lnk|local|url|scf|desktop|appref-ms)$|\.\{[^}]*\}$/i;
  const MAX_COMPONENT_BYTES = 180;
  const MAX_PATH_CHARS = 230;

  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const utf8Length = (s) => (encoder ? encoder.encode(s).length : unescape(encodeURIComponent(s)).length);

  function shortHash(text) {
    let h = 0x811c9dc5;
    for (const ch of String(text)) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function splitExt(name) {
    const m = /^(.+?)(\.[^.\s]{1,16})$/u.exec(name);
    return m ? [m[1], m[2]] : [name, ''];
  }

  function truncateComponent(name, maxBytes = MAX_COMPONENT_BYTES) {
    if (utf8Length(name) <= maxBytes) return name;
    const [base, ext] = splitExt(name);
    const tail = '_' + shortHash(name) + ext;
    const budget = Math.max(8, maxBytes - utf8Length(tail));
    let cut = '';
    for (const ch of base) {
      if (utf8Length(cut + ch) > budget) break;
      cut += ch;
    }
    return cut.replace(/[\p{White_Space}.]+$/u, '') + tail;
  }

  /** Делает одно имя (файла или папки) безопасным для chrome.downloads. */
  function sanitizeComponent(name, { strict = false } = {}) {
    const src = String(name == null ? '' : name).normalize('NFC');
    let out = '';
    for (const ch of src) {
      const cp = ch.codePointAt(0);
      const nonChar = (cp & 0xfffe) === 0xfffe || (cp >= 0xfdd0 && cp <= 0xfdef);
      if (nonChar || ILLEGAL_CHAR.test(ch) || (strict && !STRICT_ALLOWED.test(ch))) out += '_';
      else out += ch;
    }
    // Края: пробелы, точки и тильды заменяем, а не обрезаем — чтобы не склеивать имена.
    const chars = Array.from(out);
    for (let i = 0; i < chars.length && EDGE_CHARS.test(chars[i]); i++) chars[i] = '_';
    for (let i = chars.length - 1; i >= 0 && EDGE_CHARS.test(chars[i]); i--) chars[i] = '_';
    out = chars.join('');
    if (!out) out = '_';
    if (RESERVED.test(out) || MAGIC_NAMES.has(out.toLowerCase())) out = '_' + out;
    if (SHELL_EXT.test(out)) out += '_';
    return truncateComponent(out);
  }

  function joinPath(...parts) {
    return parts.filter((p) => p !== '' && p != null).join('/');
  }

  function insertSuffix(name, suffix) {
    const [base, ext] = splitExt(name);
    return base + suffix + ext;
  }

  /**
   * Раздаёт уникальные локальные пути. Сравнение без учёта регистра:
   * на Windows и macOS «Photo.jpg» и «photo.jpg» — один и тот же файл.
   */
  class PathAllocator {
    constructor() {
      this.owners = new Map();
    }
    claim(localPath, owner) {
      const key = localPath.toLowerCase();
      const prev = this.owners.get(key);
      if (prev !== undefined && prev !== owner) return false;
      this.owners.set(key, owner);
      return true;
    }
    alloc(parentLocal, name, owner) {
      const base = sanitizeComponent(name);
      let candidate = joinPath(parentLocal, base);
      for (let n = 2; !this.claim(candidate, owner); n++) {
        candidate = joinPath(parentLocal, insertSuffix(base, ` (${n})`));
      }
      return candidate;
    }
    // Восстановление после перезапуска: заново занимаем уже выданные пути.
    restore(localPath, owner) {
      const parts = localPath.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (!this.owners.has(dir.toLowerCase())) this.owners.set(dir.toLowerCase(), 'dir:' + dir.toLowerCase());
      }
      this.owners.set(localPath.toLowerCase(), owner);
    }
  }

  /** Укорачивает слишком длинный путь (Windows не любит пути длиннее ~260 символов). */
  function fitPath(rootFolder, localPath, longDir = '_Слишком длинные пути') {
    const full = joinPath(rootFolder, localPath);
    if (full.length <= MAX_PATH_CHARS) return full;
    const name = localPath.split('/').pop();
    const short = truncateComponent(shortHash(localPath) + '_' + name, 120);
    return joinPath(rootFolder, longDir, short);
  }

  /** Строгий вариант пути — на случай, если браузер всё же отверг обычный. */
  function strictPath(fullPath) {
    return fullPath
      .split('/')
      .map((part) => sanitizeComponent(part, { strict: true }))
      .join('/');
  }

  function previewName(localPath, word = 'превью') {
    const parts = localPath.split('/');
    const [base] = splitExt(parts.pop());
    parts.push(`${base} (${sanitizeComponent(word)}).jpg`);
    return parts.join('/');
  }

  // --- Пути Диска -----------------------------------------------------------
  function diskPathFromLocation(pathname) {
    const m = /^\/client\/disk(\/.*)?$/.exec(pathname || '');
    if (!m) return null;
    const rest = (m[1] || '').split('/').filter(Boolean).map(safeDecode);
    return '/disk' + (rest.length ? '/' + rest.join('/') : '');
  }

  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  function basename(path) {
    const parts = String(path).split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function dirname(path) {
    const parts = String(path).split('/');
    parts.pop();
    return parts.join('/') || '/';
  }

  /** Локальный путь для ресурса Диска: «/disk/Фото/a.jpg» → «Фото/a.jpg». */
  function relativeToDisk(path) {
    return String(path).replace(/^\/disk\/?/, '');
  }

  /** Самая глубокая общая папка: ['/disk/Фото/2019', '/disk/Документы'] → '/disk'. */
  function commonDir(paths) {
    const lists = paths.map((p) => String(p).split('/').filter(Boolean));
    if (!lists.length) return '/';
    const out = [];
    for (let i = 0; i < lists[0].length; i++) {
      const c = lists[0][i];
      if (lists.some((l) => l[i] !== c)) break;
      out.push(c);
    }
    return '/' + out.join('/');
  }

  /** Путь на компьютере для папки path относительно base: ('/disk/Фото/2019', '/disk') → 'Фото/2019'. */
  function relativeLocal(path, base) {
    const p = String(path).split('/').filter(Boolean);
    const b = String(base).split('/').filter(Boolean);
    const inside = b.every((c, i) => p[i] === c);
    return (inside ? p.slice(b.length) : p).map((c) => sanitizeComponent(c)).join('/');
  }

  // --- Ссылки ------------------------------------------------------------------
  function absoluteUrl(url) {
    if (!url) return null;
    const s = String(url).replace(/&amp;/g, '&');
    return s.startsWith('//') ? 'https:' + s : s;
  }

  function isYandexUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && /(^|\.)(yandex\.[a-z.]+|yandex\.net|yadi\.sk)$/i.test(u.hostname);
    } catch (e) {
      return false;
    }
  }

  const PREVIEW_ORDER = ['XXXL', 'XXL', 'XL', 'L', 'M', 'DEFAULT', 'S', 'XS', 'XXS'];

  function pickPreview(sizes) {
    if (!Array.isArray(sizes)) return null;
    for (const name of PREVIEW_ORDER) {
      const found = sizes.find((s) => s && s.name === name && s.url);
      if (found) return { name, url: absoluteUrl(found.url) };
    }
    return null;
  }

  /** У фото в meta.sizes бывает ORIGINAL — прямая ссылка на сам файл (/disk/…). */
  function originalFromSizes(sizes) {
    if (!Array.isArray(sizes)) return null;
    const found = sizes.find((s) => s && s.name === 'ORIGINAL' && s.url);
    if (!found) return null;
    const url = absoluteUrl(found.url);
    try {
      return new URL(url).pathname.startsWith('/disk/') ? url : null;
    } catch (e) {
      return null;
    }
  }

  function isImage(mediaType, name) {
    if (mediaType === 'image') return true;
    return !mediaType && /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|avif)$/i.test(name || '');
  }

  // --- Форматирование --------------------------------------------------------
  function plural(n, one, few, many) {
    const n10 = n % 10;
    const n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
    return many;
  }

  /** «2 папки и 5 файлов». */
  function pickSummary(dirs, files) {
    const t = YDD.t;
    const parts = [];
    if (dirs) parts.push(t('count.dirs', { n: dirs }));
    if (files) parts.push(t('count.files', { n: files }));
    if (parts.length === 2) return t('list.and', { a: parts[0], b: parts[1] });
    return parts[0] || t('pick.nothing');
  }

  function formatCount(n) {
    return Number(n || 0).toLocaleString('ru-RU');
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    const digits = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return v.toLocaleString('ru-RU', { maximumFractionDigits: digits }) + ' ' + units[i];
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const s = Math.round(seconds);
    if (s < 60) return 'меньше минуты';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} мин`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    if (h < 48) return rest ? `${h} ч ${rest} мин` : `${h} ч`;
    return `${Math.round(h / 24)} ${plural(Math.round(h / 24), 'день', 'дня', 'дней')}`;
  }

  function sleep(ms, signal) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
    });
  }

  Object.assign(YDD, {
    ST,
    sanitizeComponent,
    truncateComponent,
    PathAllocator,
    fitPath,
    strictPath,
    previewName,
    joinPath,
    splitExt,
    shortHash,
    diskPathFromLocation,
    relativeToDisk,
    commonDir,
    relativeLocal,
    basename,
    dirname,
    absoluteUrl,
    isYandexUrl,
    pickPreview,
    originalFromSizes,
    isImage,
    plural,
    pickSummary,
    TYPE_GROUPS,
    fileExt,
    typeGroup,
    formatCount,
    formatBytes,
    formatDuration,
    sleep,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = YDD;
})(typeof globalThis !== 'undefined' ? globalThis : this);
