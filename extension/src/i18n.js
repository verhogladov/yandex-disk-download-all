/*
 * Переводы интерфейса. Словари лежат в locales/<язык>.json; если в выбранном языке
 * нет какой-то строки, показывается русская. Язык выбирают в панели или на странице
 * настроек, по умолчанию — язык браузера, если он есть в списке, иначе русский.
 * Подключается и как скрипт расширения, и как модуль Node в тестах.
 */
(function (root) {
  'use strict';
  const YDD = (root.YDD = root.YDD || {});

  // Порядок — как в меню. num — по образцу какого языка записывать числа. Своим кодом нельзя:
  // у многих языков в Chrome нет этих данных (он молча берёт язык системы), а у kk, uz и az
  // они урезаны до «1,234.5». Почти везде в СНГ пишут «1 234,5», как по-русски.
  const LANGS = [
    { code: 'ru', name: 'Русский' },
    { code: 'en', name: 'English', num: 'en' },
    { code: 'uk', name: 'Українська', num: 'uk' },
    { code: 'be', name: 'Беларуская' },
    { code: 'kk', name: 'Қазақша' },
    { code: 'uz', name: 'Oʻzbekcha' },
    { code: 'ky', name: 'Кыргызча' },
    { code: 'tg', name: 'Тоҷикӣ' },
    { code: 'tk', name: 'Türkmençe' },
    { code: 'az', name: 'Azərbaycanca', num: 'tr' }, // 1.234,5
    { code: 'hy', name: 'Հայերեն' },
    { code: 'ka', name: 'ქართული' },
    { code: 'ro', name: 'Română', num: 'ro' },
    { code: 'tt', name: 'Татарча' },
    { code: 'ba', name: 'Башҡортса' },
    { code: 'cv', name: 'Чӑвашла' },
    { code: 'sah', name: 'Саха тыла' },
    { code: 'ce', name: 'Нохчийн' },
    { code: 'os', name: 'Ирон' },
    { code: 'bxr', name: 'Буряад' },
    { code: 'udm', name: 'Удмурт' },
    { code: 'kaa', name: 'Qaraqalpaqsha' },
    { code: 'crh', name: 'Qırımtatarca' },
  ];
  const CODES = new Set(LANGS.map((l) => l.code));

  const state = { lang: 'ru', dict: {}, base: {}, ready: false, plural: null, number: null };

  function knowsPlurals(locale) {
    try {
      return Intl.PluralRules.supportedLocalesOf([locale]).length > 0;
    } catch (e) {
      return false;
    }
  }

  /** Подключает словари: dict — выбранного языка, base — русский (запасной). */
  function use(lang, dict, base) {
    const info = LANGS.find((l) => l.code === lang) || LANGS[0];
    state.lang = info.code;
    state.dict = dict || {};
    state.base = base || dict || {};
    state.ready = true;
    state.number = new Intl.NumberFormat(info.num || 'ru');
    // Правила множественного числа: свои, если браузер их знает, иначе «один / много».
    // Их проверяем отдельно: у белорусского, например, числовых данных в Chrome нет, а правила есть.
    state.plural = new Intl.PluralRules(knowsPlurals(info.code) ? info.code : 'en');
  }

  function lookup(key) {
    const v = state.dict[key];
    return v != null && v !== '' ? v : state.base[key];
  }

  function formatCount(n) {
    return (state.number || new Intl.NumberFormat('ru')).format(Number(n) || 0);
  }

  /**
   * Строка по ключу. Переменные подставляются вместо {имя}; если значение — объект
   * с формами множественного числа, форма выбирается по vars.n. Число n форматируется.
   */
  function t(key, vars) {
    let v = lookup(key);
    if (v == null) return key;
    if (typeof v === 'object') {
      const n = vars && vars.n != null ? Number(vars.n) : 0;
      const cat = (state.plural || new Intl.PluralRules('ru')).select(n);
      v = v[cat] != null ? v[cat] : v.other != null ? v.other : v.many != null ? v.many : v.one;
    }
    if (!vars) return v;
    return String(v).replace(/\{(\w+)\}/g, (m, name) => {
      if (!(name in vars)) return m;
      return name === 'n' ? formatCount(vars.n) : String(vars[name]);
    });
  }

  /** Язык браузера, если он есть среди переводов; иначе русский. */
  function detect(languages) {
    for (const tag of languages || []) {
      const code = String(tag || '').toLowerCase().split(/[-_]/)[0];
      if (CODES.has(code)) return code;
    }
    return 'ru';
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    const units = ['unit.B', 'unit.KB', 'unit.MB', 'unit.GB', 'unit.TB'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    const digits = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 2;
    const locale = state.number ? state.number.resolvedOptions().locale : 'ru';
    return v.toLocaleString(locale, { maximumFractionDigits: digits }) + ' ' + t(units[i]);
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const s = Math.round(seconds);
    if (s < 60) return t('time.lessMinute');
    const m = Math.round(s / 60);
    if (m < 60) return t('time.minutes', { n: m });
    const h = Math.floor(m / 60);
    const rest = m % 60;
    if (h < 48) return rest ? t('time.hoursMinutes', { h: formatCount(h), m: formatCount(rest) }) : t('time.hours', { n: h });
    return t('time.days', { n: Math.round(h / 24) });
  }

  YDD.i18n = {
    LANGS,
    use,
    detect,
    has: (code) => CODES.has(code),
    get lang() {
      return state.lang;
    },
    get ready() {
      return state.ready;
    },
  };
  // Форматирование зависит от языка — подменяем русские версии из util.js.
  Object.assign(YDD, { t, formatCount, formatBytes, formatDuration });
  if (typeof module !== 'undefined' && module.exports) module.exports = YDD;
})(typeof globalThis !== 'undefined' ? globalThis : this);
