/* Страница настроек: куда переносить файлы. */
(function () {
  'use strict';
  const YDD = globalThis.YDD;
  const t = YDD.t;
  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');

  // --- Язык страницы ------------------------------------------------------------------
  const dictionaries = new Map();
  function loadDict(code) {
    if (!dictionaries.has(code)) {
      dictionaries.set(
        code,
        fetch(chrome.runtime.getURL(`locales/${code}.json`))
          .then((res) => res.json())
          .catch(() => ({}))
      );
    }
    return dictionaries.get(code);
  }

  function el(tag, text) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    return node;
  }

  /** Строка с адресом-примером: «Nextcloud: https://адрес/…». */
  function example(label, ...parts) {
    const li = el('li', label + ': ');
    li.append(el('code', parts.join('')));
    return li;
  }

  function translatePage() {
    document.documentElement.lang = YDD.i18n.lang;
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
    for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
    $('lang').setAttribute('aria-label', t('app.language'));
    const note = t('translation.note');
    $('translation-note').hidden = !note;
    $('translation-note').firstElementChild.textContent = note;
    const login = t('opt.loginPlaceholder');
    const folder = t('opt.folderPlaceholder');
    const address = t('opt.address');
    $('dav-examples').replaceChildren(
      example('Nextcloud', `https://${address}/remote.php/dav/files/${login}/${folder}`),
      example(t('opt.exampleSynology'), `https://${address}:5006/${folder}`),
      example('Hetzner Storage Box', `https://uXXXXX.your-storagebox.de/${folder}`),
      example('Koofr', `https://app.koofr.net/dav/Koofr/${folder}`),
      (() => {
        const li = example('pCloud', `https://webdav.pcloud.com/${folder}`);
        li.append(` (${t('opt.exampleRegion')} — `, el('code', 'ewebdav.pcloud.com'), ')');
        return li;
      })()
    );
    const region = t('opt.regionWord');
    const s3Example = (name, endpoint, reg) => {
      const li = example(name, endpoint);
      if (reg) li.append(`, ${region} `, el('code', reg));
      return li;
    };
    $('s3-examples').replaceChildren(
      s3Example('Selectel', 'https://s3.ru-1.storage.selcloud.ru', 'ru-1'),
      s3Example('Yandex Object Storage', 'https://storage.yandexcloud.net', 'ru-central1'),
      s3Example('Cloudflare R2', `https://${t('opt.accountId')}.r2.cloudflarestorage.com`, 'auto'),
      s3Example('Backblaze B2', `https://s3.${t('opt.regionPlaceholder')}.backblazeb2.com`, '')
    );
    // «Адрес вида endpoint/бакет (path-style)…» — с кусками кода внутри текста.
    const [before, middle, after] = t('opt.pathStyle').split(/\{a\}|\{b\}/);
    const bucket = t('opt.bucketWord');
    $('s3-path-text').replaceChildren(before || '', el('code', `endpoint/${bucket}`), middle || '', el('code', `${bucket}.endpoint`), after || '');
  }

  async function useLang(code) {
    const lang = YDD.i18n.has(code) ? code : 'ru';
    const [dict, base] = await Promise.all([loadDict(lang), loadDict('ru')]);
    YDD.i18n.use(lang, dict, base);
    $('lang').value = lang;
    translatePage();
  }

  for (const l of YDD.i18n.LANGS) {
    const option = el('option', l.name);
    option.value = l.code;
    $('lang').append(option);
  }
  // Как и в панели: сначала запоминаем выбор, потом переводим страницу.
  let wanted = null;
  $('lang').addEventListener('change', async () => {
    wanted = YDD.i18n.has($('lang').value) ? $('lang').value : 'ru';
    await chrome.storage.local.set({ 'ydd:lang': wanted });
    await useLang(wanted);
    statusEl.hidden = true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    const lang = area === 'local' && changes['ydd:lang'] && changes['ydd:lang'].newValue;
    if (lang && lang !== YDD.i18n.lang && lang !== wanted) {
      wanted = lang;
      useLang(lang);
    }
  });

  function show(kind, text) {
    statusEl.hidden = false;
    statusEl.className = 'status ' + kind;
    statusEl.textContent = text;
  }

  function currentKind() {
    const checked = document.querySelector('input[name=kind]:checked');
    return checked ? checked.value : 'local';
  }

  function syncForms() {
    const kind = currentKind();
    $('webdav-form').hidden = kind !== 'webdav';
    $('s3-form').hidden = kind !== 's3';
    $('privacy-note').hidden = kind === 'local';
    $('test').hidden = kind === 'local';
  }

  function readForm() {
    const kind = currentKind();
    if (kind === 'webdav') {
      return { type: 'webdav', url: $('dav-url').value.trim(), username: $('dav-user').value.trim(), password: $('dav-pass').value };
    }
    if (kind === 's3') {
      return {
        type: 's3',
        endpoint: $('s3-endpoint').value.trim(),
        region: $('s3-region').value.trim(),
        bucket: $('s3-bucket').value.trim(),
        prefix: $('s3-prefix').value.trim(),
        accessKeyId: $('s3-key').value.trim(),
        secretAccessKey: $('s3-secret').value,
        pathStyle: $('s3-path').checked,
      };
    }
    return { type: 'local' };
  }

  function fillForm(cfg) {
    const kind = (cfg && cfg.type) || 'local';
    const radio = $('kind-' + kind);
    if (radio) radio.checked = true;
    if (kind === 'webdav') {
      $('dav-url').value = cfg.url || '';
      $('dav-user').value = cfg.username || '';
      $('dav-pass').value = cfg.password || '';
    } else if (kind === 's3') {
      $('s3-endpoint').value = cfg.endpoint || '';
      $('s3-region').value = cfg.region || '';
      $('s3-bucket').value = cfg.bucket || '';
      $('s3-prefix').value = cfg.prefix || '';
      $('s3-key').value = cfg.accessKeyId || '';
      $('s3-secret').value = cfg.secretAccessKey || '';
      $('s3-path').checked = cfg.pathStyle !== false;
    }
    syncForms();
  }

  /** Всё, что можно проверить без сети. Бросает ошибку с понятным текстом. */
  function validate(cfg) {
    if (cfg.type === 'webdav') {
      if (!/^https?:\/\//i.test(cfg.url)) throw new Error(t('opt.errDavUrl'));
    } else if (cfg.type === 's3') {
      if (!/^https?:\/\//i.test(cfg.endpoint)) throw new Error(t('opt.errS3Url'));
      if (!cfg.bucket) throw new Error(t('opt.errBucket'));
      if (!cfg.accessKeyId || !cfg.secretAccessKey) throw new Error(t('opt.errKeys'));
    }
    return YDD.createDestination(cfg);
  }

  function originPattern(dest) {
    const u = new URL(dest.origin);
    return `${u.protocol}//${u.hostname}/*`;
  }

  /**
   * Разрешение на доступ к серверу нужно запросить сразу по нажатию кнопки,
   * пока браузер считает это действием пользователя, — поэтому без await до вызова.
   */
  function requestAccess(dest) {
    return chrome.permissions.request({ origins: [originPattern(dest), ...YDD.YANDEX_MEDIA_ORIGINS] });
  }

  async function check(dest, accessPromise) {
    let granted = false;
    try {
      granted = await accessPromise;
    } catch (e) {
      throw new Error(t('opt.errPermission', { error: e.message }));
    }
    if (!granted) throw new Error(t('opt.errNoPermission'));
    show('wait', t('opt.checking'));
    await dest.test();
  }

  function describeError(e) {
    return (e && e.message) || String(e);
  }

  $('test').addEventListener('click', async () => {
    let dest;
    let access;
    try {
      dest = validate(readForm());
      access = requestAccess(dest);
    } catch (e) {
      return show('err', describeError(e));
    }
    $('test').disabled = true;
    try {
      await check(dest, access);
      show('ok', t('opt.works', { name: dest.describe() }));
    } catch (e) {
      show('err', describeError(e));
    } finally {
      $('test').disabled = false;
    }
  });

  $('save').addEventListener('click', async () => {
    const cfg = readForm();
    if (cfg.type === 'local') {
      await chrome.storage.local.remove(['ydd:dest', 'ydd:dest:config']);
      return show('ok', t('opt.savedLocal'));
    }
    let dest;
    let access;
    try {
      dest = validate(cfg);
      access = requestAccess(dest);
    } catch (e) {
      return show('err', describeError(e));
    }
    $('save').disabled = true;
    try {
      await check(dest, access);
      await chrome.storage.local.set({ 'ydd:dest:config': cfg, 'ydd:dest': { type: cfg.type, label: dest.describe() } });
      show('ok', t('opt.saved', { name: dest.describe() }));
    } catch (e) {
      show('err', describeError(e));
    } finally {
      $('save').disabled = false;
    }
  });

  for (const radio of document.querySelectorAll('input[name=kind]')) radio.addEventListener('change', syncForms);

  chrome.storage.local.get(['ydd:dest:config', 'ydd:lang']).then(async (data) => {
    await useLang(data['ydd:lang'] || YDD.i18n.detect(navigator.languages || [navigator.language]));
    fillForm(data['ydd:dest:config'] || { type: 'local' });
    document.documentElement.dataset.ready = 'true';
  });
})();
