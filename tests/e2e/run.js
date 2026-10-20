'use strict';
/*
 * Проверка расширения в настоящем Chrome (Chrome for Testing) против поддельного Яндекс Диска.
 *
 *   cd tests/e2e && npm install && npm test
 *
 * Имена disk.yandex.ru и др. направляются на локальный сервер (--host-resolver-rules),
 * сертификат самоподписанный (--ignore-certificate-errors). Ничего не уходит в интернет.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const puppeteer = require('puppeteer');
const aws4 = require('aws4');
const S3rver = require('s3rver');
const { startMock, content, mtimeOf, JPEG, UNLIM, PUBLIC_HASH, DAV_HOST, S3_HOST } = require('./mock-yandex');
const { readZip } = require('../zip-reader');

const SOURCE_EXT = path.resolve(__dirname, '..', '..', 'extension');
const HEADLESS = process.env.HEADFUL ? false : true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, details = '') {
  results.push({ name, ok: !!ok, details });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && details ? ' — ' + details : ''}`);
}

async function waitFor(fn, { timeout = 60000, interval = 250, what = 'условие' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`Не дождались: ${what}. Последнее значение: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

function makeCert(dir) {
  const cfg = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(
    cfg,
    `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=disk.yandex.ru\n[ext]\nsubjectAltName=DNS:disk.yandex.ru,DNS:*.disk.yandex.ru,DNS:downloader.disk.yandex.ru,DNS:*.downloader.disk.yandex.ru,DNS:*.storage.yandex.net,DNS:cloud-api.yandex.net,DNS:${DAV_HOST},DNS:${S3_HOST}\n`
  );
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-config', cfg], {
    stdio: 'ignore',
  });
  return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
}

/**
 * Копия расширения для теста: доступ к тестовым облакам и серверам Яндекса выдан заранее,
 * иначе браузер показал бы окно с запросом разрешения, которое автотест не нажмёт.
 */
function testBuild(dir) {
  const out = path.join(dir, 'extension');
  fs.cpSync(SOURCE_EXT, out, { recursive: true });
  const manifestPath = path.join(out, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions.push(
    'https://*.disk.yandex.ru/*',
    'https://*.disk.yandex.com/*',
    'https://*.disk.yandex.net/*',
    'https://*.storage.yandex.net/*',
    'https://*.storage.yandex.ru/*',
    `https://${DAV_HOST}/*`,
    `https://${S3_HOST}/*`
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return out;
}

/** Читает объект прямо из s3rver (минуя проверяющий прокси). */
function s3Get(port, key) {
  const opts = { host: '127.0.0.1', port, path: '/backup/' + key.split('/').map(encodeURIComponent).join('/'), service: 's3', region: 'ru-1' };
  aws4.sign(opts, { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' });
  return new Promise((resolve, reject) => {
    http
      .get(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

function listFiles(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).normalize('NFC'));
  }
  return out.sort();
}

// --- Работа с панелью расширения (Shadow DOM) -----------------------------------
const ui = {
  fab: (page) => page.evaluate(() => {
    const root = document.querySelector('ydd-download-all')?.shadowRoot;
    return root ? root.querySelector('.fab .label').textContent : '';
  }),
  text: (page) => page.evaluate(() => document.querySelector('ydd-download-all')?.shadowRoot?.querySelector('.panel')?.innerText || ''),
  isOpen: (page) => page.evaluate(() => !document.querySelector('ydd-download-all').shadowRoot.querySelector('.panel').hidden),
  clickFab: (page) => page.evaluate(() => document.querySelector('ydd-download-all').shadowRoot.querySelector('.fab').click()),
  // Только кнопки панели: у плавающей кнопки бывает подпись «Готово · …».
  click: (page, label) =>
    page.evaluate((t) => {
      const root = document.querySelector('ydd-download-all').shadowRoot;
      const b = [...root.querySelectorAll('.panel button')].find((x) => x.textContent.trim().startsWith(t) && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    }, label),
  scope: (page) => page.evaluate(() => document.querySelector('ydd-download-all').shadowRoot.querySelector('input[name=scope]:checked')?.value || null),
  scopes: (page) => page.evaluate(() => [...document.querySelector('ydd-download-all').shadowRoot.querySelectorAll('input[name=scope]')].map((i) => i.value)),
  choose: (page, name, value) =>
    page.evaluate(
      (n, v) => {
        const el = document.querySelector('ydd-download-all').shadowRoot.querySelector(`input[name="${n}"][value="${v}"]`);
        if (!el) return false;
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      name,
      value
    ),
  setChecked: (page, name, value) =>
    page.evaluate(
      (n, v) => {
        const el = document.querySelector('ydd-download-all').shadowRoot.querySelector(`input[name="${n}"]`);
        if (!el) return false;
        el.checked = v;
        return true;
      },
      name,
      value
    ),
};

// --- Окно выбора файлов и папок в панели ---------------------------------------------
const picker = {
  names: (page) =>
    page.evaluate(() => [...document.querySelector('ydd-download-all').shadowRoot.querySelectorAll('ul.plist li.pitem')].map((li) => li.dataset.name)),
  row: (page, name, action) =>
    page.evaluate(
      (n, a) => {
        const li = [...document.querySelector('ydd-download-all').shadowRoot.querySelectorAll('ul.plist li.pitem')].find((x) => x.dataset.name === n);
        if (!li) return null;
        const box = li.querySelector('input');
        if (a === 'toggle') box.click();
        if (a === 'open') li.querySelector('button.pname').click();
        return { checked: box.checked, disabled: box.disabled };
      },
      name,
      action
    ),
  crumb: (page, label) =>
    page.evaluate((t) => {
      const b = [...document.querySelector('ydd-download-all').shadowRoot.querySelectorAll('.crumbs button')].find((x) => x.textContent === t);
      if (!b) return false;
      b.click();
      return true;
    }, label),
  summary: (page) => page.evaluate(() => document.querySelector('ydd-download-all').shadowRoot.querySelector('details.psel summary')?.textContent || ''),
  more: (page) => ui.click(page, 'Показать ещё'),
};

async function pickerWaitFor(page, name) {
  await waitFor(async () => (await picker.names(page)).includes(name), { what: `«${name}» в списке выбора`, timeout: 20000 });
}

/** Клик, который браузер считает действием пользователя (нужно для chrome.permissions.request). */
async function gestureClick(page, selector) {
  const client = await page.createCDPSession();
  try {
    await client.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)}).click()`, userGesture: true });
  } finally {
    await client.detach().catch(() => {});
  }
}

async function openPanel(page) {
  if (!(await ui.isOpen(page))) await ui.clickFab(page);
  await waitFor(() => ui.isOpen(page), { what: 'панель открылась' });
}

async function clickButton(page, label) {
  try {
    await waitFor(() => ui.click(page, label), { what: `кнопка «${label}»`, timeout: 15000 });
  } catch (e) {
    e.message += `\nКнопка: ${await ui.fab(page).catch(() => '?')}. Панель${(await ui.isOpen(page).catch(() => false)) ? '' : ' (закрыта)'}:\n` + (await ui.text(page).catch(() => '?'));
    throw e;
  }
}

/** Ждём завершения именно этого задания: его заголовок в панели и статус «Готово». */
async function waitJobDone(page, titleRe, timeout = 120000) {
  try {
    return await waitFor(
      () =>
        page.evaluate((src) => {
          const root = document.querySelector('ydd-download-all').shadowRoot;
          const title = root.querySelector('.job-title');
          const badge = root.querySelector('.badge');
          return !!(title && badge && new RegExp(src).test(title.textContent) && badge.textContent === 'Готово');
        }, titleRe.source),
      { timeout, interval: 500, what: `завершение задания ${titleRe}` }
    );
  } catch (e) {
    e.message += '\nПанель:\n' + (await ui.text(page).catch(() => '?'));
    throw e;
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ydd-e2e-'));
  const downloads = path.join(tmp, 'Загрузки');
  const profile = path.join(tmp, 'profile');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.mkdirSync(downloads);
  fs.writeFileSync(
    path.join(profile, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
      savefile: { default_directory: downloads },
      // Язык панели определяется по языкам браузера: проверки ниже рассчитаны на русский.
      intl: { accept_languages: 'ru-RU,ru', selected_languages: 'ru-RU,ru' },
    })
  );
  const s3 = new S3rver({
    port: 0,
    address: '127.0.0.1',
    silent: true,
    vhostBuckets: false, // иначе s3rver принимает имя хоста за имя бакета
    directory: path.join(tmp, 's3'),
    configureBuckets: [{ name: 'backup' }],
  });
  const s3Address = await s3.run();
  const s3Port = s3Address.port;
  const mock = await startMock(Object.assign(makeCert(tmp), { s3Port, aws4 }));
  const p = mock.port;
  const EXT = testBuild(tmp);
  console.log(`Поддельный Диск на порту ${p}, загрузки → ${downloads}`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    // CHROME_PATH — проверить в другом браузере на Chromium, например в обычном Google Chrome.
    executablePath: process.env.CHROME_PATH || undefined,
    pipe: true,
    enableExtensions: [EXT],
    userDataDir: profile,
    args: [
      `--host-resolver-rules=MAP disk.yandex.ru 127.0.0.1:${p},MAP *.disk.yandex.ru 127.0.0.1:${p},MAP *.storage.yandex.net 127.0.0.1:${p},MAP cloud-api.yandex.net 127.0.0.1:${p},MAP ${DAV_HOST} 127.0.0.1:${p},MAP ${S3_HOST} 127.0.0.1:${p},EXCLUDE localhost`,
      '--ignore-certificate-errors',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
    ],
  });
  const logs = [];
  try {
    const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 20000 });
    const sw = await swTarget.worker();
    // Короткие сроки ожидания, чтобы «мёртвые» файлы не тянули тест по минуте.
    await sw.evaluate(() =>
      chrome.storage.local.set({
        'ydd:timing': { startMs: 4000, firstByteMs: 4000, stallMs: 4000, retryDelayMs: 500, pollMs: 500, flushMs: 200, slowFactor: 1 },
      })
    );

    // Консоль невидимого offscreen-документа (перенос в облако): туда браузер пишет сетевые ошибки.
    browser.on('targetcreated', async (t) => {
      if (!t.url().endsWith('/offscreen.html')) return;
      try {
        const cdp = await t.createCDPSession();
        cdp.on('Runtime.consoleAPICalled', (e) => logs.push('[offscreen] ' + e.args.map((a) => a.value ?? a.description).join(' ')));
        cdp.on('Runtime.exceptionThrown', (e) => logs.push('[offscreen, исключение] ' + e.exceptionDetails.text));
        cdp.on('Log.entryAdded', (e) => logs.push('[offscreen, ' + e.entry.source + '] ' + e.entry.text));
        await cdp.send('Runtime.enable');
        await cdp.send('Log.enable');
      } catch (e) {
        logs.push('[offscreen] не удалось подключиться: ' + e.message);
      }
    });
    const page = await browser.newPage();
    page.on('console', (m) => {
      const t = m.text();
      if (/YDD|Uncaught|Error/i.test(t)) logs.push(`[страница] ${t}`);
    });
    page.on('pageerror', (e) => logs.push(`[страница, исключение] ${e.message}`));

    // ---------- 1. Весь Диск + Безлимит ----------
    console.log('\n1. Весь Диск вместе с «Безлимитом»');
    await page.goto('https://disk.yandex.ru/client/disk', { waitUntil: 'domcontentloaded' });
    await waitFor(async () => (await ui.fab(page)) === 'Скачать весь Диск', { what: 'кнопка на странице' });
    check('кнопка «Скачать весь Диск» появилась на странице', true);
    await openPanel(page);
    const setupText = await ui.text(page);
    check('в панели выбран «Весь Диск»', (await ui.scope(page)) === 'all', await ui.scope(page));
    check('показан объём Диска из данных страницы', /Весь Диск[\s\S]*\d+ файл/.test(setupText));
    check('есть галочка «Безлимит»', /Безлимит/.test(setupText));
    check('есть предупреждение про «Всегда указывать место»', /Всегда указывать место для скачивания/.test(setupText));
    await clickButton(page, 'Начать скачивание');
    const t0 = Date.now();
    await waitJobDone(page, /^Весь Диск$/, 180000);
    console.log(`   скачано за ${Math.round((Date.now() - t0) / 1000)} с`);
    const panel1 = await ui.text(page);
    const files1 = listFiles(downloads);
    const root = 'Яндекс Диск';
    const expect = (local, remote) => {
      const full = path.join(downloads, root, local);
      if (!fs.existsSync(full)) return check(`файл ${local}`, false, 'нет на диске');
      const same = fs.readFileSync(full).equals(content(remote));
      check(`файл ${local} совпадает с оригиналом`, same, same ? '' : 'содержимое отличается');
    };
    expect('readme.txt', '/disk/readme.txt');
    expect('_hidden', '/disk/.hidden');
    expect('_CON.txt', '/disk/CON.txt');
    expect('Отчёт_ итоги_.txt', '/disk/Отчёт: итоги?.txt');
    expect('копия_1.txt', '/disk/копия~1.txt');
    expect('Фото/IMG_000.jpg', '/disk/Фото/IMG_000.jpg');
    expect('Фото/IMG_044.jpg', '/disk/Фото/IMG_044.jpg');
    expect('Фото/2019/A.JPG', '/disk/Фото/2019/A.JPG');
    expect('Фото/2019/a (2).jpg', '/disk/Фото/2019/a.jpg');
    expect('Документы/flaky.pdf', '/disk/Документы/flaky.pdf');
    expect('Документы/Глубоко/Ещё глубже/файл.txt', '/disk/Документы/Глубоко/Ещё глубже/файл.txt');
    expect('Медленно/slow.bin', '/disk/Медленно/slow.bin');
    expect('Видео/Отпуск 2019.mov', '/disk/Видео/Отпуск 2019.mov');
    expect('Аварийные/после.txt', '/disk/Аварийные/после.txt');
    for (const u of UNLIM) expect('Фото из безлимита/' + path.basename(u), u);
    const previewPath = path.join(downloads, root, 'Фото', 'dead (превью).jpg');
    check('для «мёртвого» фото сохранено превью', fs.existsSync(previewPath) && fs.readFileSync(previewPath).equals(JPEG));
    check('оригинал «мёртвого» фото не создан', !fs.existsSync(path.join(downloads, root, 'Фото', 'dead.jpg')));
    check('удалённого файла нет', !files1.some((f) => f.includes('gone.docx')));
    check('«мёртвого» видео нет', !files1.some((f) => f.includes('dead.mp4')));
    check('нет недокачанных .crdownload', !files1.some((f) => f.endsWith('.crdownload')), files1.filter((f) => f.endsWith('.crdownload')).join(', '));
    // 45 фото + превью dead.jpg + 2 в «2019» + 5 в корне + 2 документа + 2 в «Медленно» + безлимит
    const expectedCount = 45 + 1 + 2 + 5 + 2 + 2 + 1 + 1 + UNLIM.length;
    check(`всего файлов ${expectedCount}`, files1.length === expectedCount, `найдено ${files1.length}: ${files1.join(', ')}`);
    check('в панели: 10 ошибок (2 файла + 8 «мёртвых» подряд)', /Не удалось: 10\b/.test(panel1), panel1);
    check('в панели: 1 превью', /Только превью: 1/.test(panel1));
    check('sk обновлён по ошибке CKEY', mock.state.ckeyIssued >= 1, `CKEY выдан ${mock.state.ckeyIssued} раз`);
    const usedOldSkAfterFix = mock.state.api.slice(mock.state.api.findIndex((a) => a.sk !== 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678:1760900000') + 1).some((a) => a.sk.startsWith('a1b2'));
    check('после обновления старый sk больше не используется', !usedOldSkAfterFix);
    check('ответ 429 выдержан и обход продолжился', mock.state.rateLimited === 1);
    check('параметры запросов совпадают с веб-версией Диска', mock.state.badParams.length === 0, mock.state.badParams.join('; '));
    check('cookie сессии отправлялись при скачивании', mock.state.cookieMissing === 0, `без cookie: ${mock.state.cookieMissing}`);
    check('сбойный файл скачан со второй попытки', mock.state.requests['/disk/Документы/flaky.pdf'] >= 2, JSON.stringify(mock.state.requests['/disk/Документы/flaky.pdf']));
    check('после «мёртвого» файла ссылки проверяются коротким запросом', Object.keys(mock.state.probes).length > 0);
    check('каждый обычный файл скачан один раз', mock.state.downloads['/disk/Фото/IMG_010.jpg'] === 1 && mock.state.downloads['/disk/readme.txt'] === 1);
    check('превью запрошено в JPEG', mock.state.previewAccept.some((a) => a.includes('image/jpeg')), mock.state.previewAccept.join(' | '));
    // Запись стирается сразу после завершения файла, но асинхронно — даём ей пару секунд.
    let history = -1;
    for (let i = 0; i < 20 && history !== 0; i++) {
      history = await sw.evaluate(() => chrome.downloads.search({ state: 'complete' }).then((x) => x.length));
      if (history) await sleep(250);
    }
    check('список загрузок браузера не засорён', history === 0, `завершённых записей: ${history}`);

    // Отчёт
    await clickButton(page, 'Отчёт (CSV)');
    const report = await waitFor(() => listFiles(downloads).find((f) => /отчёт.*\.csv$/.test(f)), { what: 'файл отчёта', timeout: 15000 });
    const csv = fs.readFileSync(path.join(downloads, report), 'utf8');
    check('отчёт содержит не скачанные файлы', /gone\.docx";"не скачан";.*больше нет на Диске/.test(csv) && /dead\.mp4";"не скачан"/.test(csv), csv.slice(0, 500));
    if (results.some((r) => !r.ok)) console.log('   Отчёт расширения:\n' + csv.replace(/^/gm, '     '));
    fs.unlinkSync(path.join(downloads, report));

    // ---------- 2. Выделенное, без повторного скачивания ----------
    console.log('\n2. Выделенное в папке «Фото» (уже скачанное не качаем)');
    const before = Object.assign({}, mock.state.downloads);
    await page.goto('https://disk.yandex.ru/client/disk/%D0%A4%D0%BE%D1%82%D0%BE', { waitUntil: 'domcontentloaded' });
    await waitFor(async () => /Готово/.test(await ui.fab(page)), { what: 'прошлое задание видно на кнопке' });
    await openPanel(page);
    await clickButton(page, 'Новая загрузка');
    await clickButton(page, 'Выбрать, что скачать');
    await waitFor(async () => (await ui.scopes(page)).includes('selection'), { what: 'вариант «Выделенное»' });
    check('варианты: весь Диск, папка, выделенное, выбор вручную', JSON.stringify(await ui.scopes(page)) === '["all","folder","selection","pick"]', JSON.stringify(await ui.scopes(page)));
    check('по умолчанию выбрано «Выделенное»', (await ui.scope(page)) === 'selection');
    check('выделено 2 объекта', /Выделенное: 2 объекта/.test(await ui.text(page)));
    await clickButton(page, 'Начать скачивание');
    await waitJobDone(page, /^Выделенное в «Фото»: 2$/);
    const panel2 = await ui.text(page);
    check('уже скачанные файлы не скачивались заново', JSON.stringify(before) === JSON.stringify(mock.state.downloads), JSON.stringify(mock.state.downloads));
    check('в панели: «Было скачано раньше: 3»', /Было скачано раньше: 3/.test(panel2), panel2);

    // ---------- 3. Публичная ссылка ----------
    console.log('\n3. Публичная ссылка');
    await page.goto(`https://disk.yandex.ru/d/${PUBLIC_HASH}`, { waitUntil: 'domcontentloaded' });
    await waitFor(async () => (await ui.fab(page)) === 'Скачать всё', { what: 'кнопка на публичной странице' });
    await openPanel(page);
    check('в панели: «Всё по ссылке «Общая папка»»', /Всё по ссылке «Общая папка»/.test(await ui.text(page)));
    await clickButton(page, 'Начать скачивание');
    await waitJobDone(page, /^Ссылка «Общая папка»$/);
    const pubRoot = path.join(downloads, root, 'Публичные ссылки', 'Общая папка');
    check('публичный файл x.txt', fs.existsSync(path.join(pubRoot, 'x.txt')) && fs.readFileSync(path.join(pubRoot, 'x.txt')).equals(content('pub:/x.txt')));
    check('публичный файл во вложенной папке', fs.existsSync(path.join(pubRoot, 'Вложенная', 'y.jpg')) && fs.readFileSync(path.join(pubRoot, 'Вложенная', 'y.jpg')).equals(content('pub:/Вложенная/y.jpg')));

    // ---------- 4. Перезагрузка страницы посреди скачивания ----------
    console.log('\n4. Перезагрузка страницы во время скачивания');
    await page.goto('https://disk.yandex.ru/client/disk/%D0%9C%D0%B5%D0%B4%D0%BB%D0%B5%D0%BD%D0%BD%D0%BE', { waitUntil: 'domcontentloaded' });
    await waitFor(async () => (await ui.fab(page)).length > 0, { what: 'кнопка' });
    await openPanel(page);
    await clickButton(page, 'Новая загрузка');
    await clickButton(page, 'Выбрать, что скачать');
    await waitFor(async () => (await ui.scope(page)) === 'folder', { what: 'выбрана текущая папка' });
    await ui.setChecked(page, 'skipDone', false);
    const slowBefore = mock.state.downloads['/disk/Медленно/slow.bin'] || 0;
    await clickButton(page, 'Начать скачивание');
    await waitFor(() => (mock.state.downloads['/disk/Медленно/slow.bin'] || 0) > slowBefore, { what: 'началось медленное скачивание' });
    await sleep(1500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    check('после перезагрузки задание продолжилось само', await waitFor(async () => /Скачивание|Готово/.test(await ui.fab(page)), { what: 'продолжение', timeout: 20000 }));
    await waitJobDone(page, /^Папка «Медленно»$/);
    check('медленный файл не начинали заново', mock.state.downloads['/disk/Медленно/slow.bin'] === slowBefore + 1, `запросов: ${mock.state.downloads['/disk/Медленно/slow.bin']}`);
    const slowFile = path.join(downloads, root, 'Медленно', 'slow.bin');
    check('медленный файл скачан целиком', fs.existsSync(slowFile) && fs.readFileSync(slowFile).equals(content('/disk/Медленно/slow.bin')));
    check('нет недокачанных файлов', !listFiles(downloads).some((f) => f.endsWith('.crdownload')));

    // ---------- 5. Перенос на свой сервер по WebDAV ----------
    console.log('\n5. Перенос на сервер по WebDAV (без сохранения на компьютер)');
    const extId = new URL(swTarget.url()).host;
    const options = await browser.newPage();
    options.on('pageerror', (e) => logs.push(`[настройки, исключение] ${e.message}`));
    await options.bringToFront();
    await options.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'domcontentloaded' });
    await options.waitForFunction(() => document.documentElement.dataset.ready === 'true', { polling: 200, timeout: 15000 });
    const fill = (values) =>
      options.evaluate((v) => {
        for (const [id, value] of Object.entries(v)) {
          const el = document.getElementById(id);
          if (el.type === 'radio' || el.type === 'checkbox') el.checked = value;
          else el.value = value;
          el.dispatchEvent(new Event(el.type === 'radio' ? 'change' : 'input', { bubbles: true }));
        }
      }, values);
    const statusText = () => options.evaluate(() => document.getElementById('status').textContent);
    await fill({ 'kind-webdav': true, 'dav-url': `https://${DAV_HOST}/remote.php/dav/files/tester/Архив`, 'dav-user': 'tester', 'dav-pass': 'неверный' });
    await gestureClick(options, '#test');
    await waitFor(async () => /не принял логин или пароль/.test(await statusText()), { what: 'отказ при неверном пароле', timeout: 20000 });
    check('неверный пароль WebDAV распознан', true);
    await fill({ 'dav-pass': 'секрет-123' });
    await gestureClick(options, '#test');
    await waitFor(async () => /Подключение работает/.test(await statusText()), { what: 'проверка WebDAV', timeout: 20000 });
    check('проверка подключения WebDAV прошла', mock.state.davDirs.has('/remote.php/dav/files/tester/Архив'));
    await gestureClick(options, '#save');
    await waitFor(async () => /Сохранено/.test(await statusText()), { what: 'сохранение настроек', timeout: 20000 });
    const localBefore = listFiles(downloads);
    await page.bringToFront();
    await page.goto('https://disk.yandex.ru/client/disk/%D0%94%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D1%8B', { waitUntil: 'domcontentloaded' });
    await waitFor(async () => (await ui.fab(page)).length > 0, { what: 'кнопка' });
    await openPanel(page);
    await clickButton(page, 'Новая загрузка');
    await clickButton(page, 'Выбрать, что скачать');
    await waitFor(async () => (await ui.scope(page)) === 'folder', { what: 'выбрана текущая папка' });
    const destChecked = await page.evaluate(() => document.querySelector('ydd-download-all').shadowRoot.querySelector('input[name=dest]:checked')?.value);
    check('в панели по умолчанию выбрано подключённое облако', destChecked === 'remote', destChecked);
    check('название облака показано в панели', /WebDAV · dav\.example\.test/.test(await ui.text(page)));
    await ui.setChecked(page, 'skipDone', false);
    await clickButton(page, 'Начать скачивание');
    await waitJobDone(page, /^Папка «Документы»$/);
    const davRoot = '/remote.php/dav/files/tester/Архив/Яндекс Диск/Документы/';
    const davFile = (rel, remote) => {
      const got = mock.state.dav.get(davRoot + rel);
      check(`на сервере: Документы/${rel}`, got && got.equals(content(remote)), got ? 'содержимое отличается' : 'нет файла');
    };
    davFile('flaky.pdf', '/disk/Документы/flaky.pdf');
    davFile('Глубоко/Ещё глубже/файл.txt', '/disk/Документы/Глубоко/Ещё глубже/файл.txt');
    check('недоступные файлы на сервер не попали', ![...mock.state.dav.keys()].some((k) => /gone\.docx|dead\.mp4/.test(k)));
    check('на компьютер ничего не сохранялось', JSON.stringify(listFiles(downloads)) === JSON.stringify(localBefore), listFiles(downloads).filter((f) => !localBefore.includes(f)).join(', '));
    const panel5 = await ui.text(page);
    const errors5 = await page.evaluate(() => [...document.querySelector('ydd-download-all').shadowRoot.querySelectorAll('ul.errlist li')].map((li) => li.textContent).join(' | '));
    if (!/Не удалось: 2/.test(panel5)) console.log('   Ошибки в панели:', errors5);
    check('в панели: «Куда: WebDAV · dav.example.test»', /Куда: WebDAV · dav\.example\.test/.test(panel5), panel5);
    check('в панели: 2 ошибки (удалённый и «мёртвый» файл)', /Не удалось: 2/.test(panel5), panel5);

    // ---------- 6. Перенос в S3 (большой файл — по частям) ----------
    console.log('\n6. Перенос в S3-хранилище, большой файл по частям');
    await options.bringToFront();
    await options.reload({ waitUntil: 'domcontentloaded' });
    await options.waitForFunction(() => document.documentElement.dataset.ready === 'true', { polling: 200, timeout: 15000 });
    await fill({
      'kind-s3': true,
      's3-endpoint': `https://${S3_HOST}`,
      's3-region': 'ru-1',
      's3-bucket': 'backup',
      's3-prefix': 'disk',
      's3-key': 'S3RVER',
      's3-secret': 'S3RVER',
    });
    await gestureClick(options, '#save');
    await waitFor(async () => /Сохранено/.test(await statusText()), { what: 'сохранение S3', timeout: 20000 }).catch(async (e) => {
      e.message += ' Статус: ' + (await statusText()) + ' | S3: ' + mock.state.s3Log.join(' ; ') + ' | подписи: ' + mock.state.s3SignatureErrors.join(' ; ');
      throw e;
    });
    check('проверка подключения S3 прошла', mock.state.s3Log.some((l) => l.startsWith('DELETE /backup/disk/.ydd-test-')));
    await page.bringToFront();
    await page.goto('https://disk.yandex.ru/client/disk/%D0%92%D0%B8%D0%B4%D0%B5%D0%BE', { waitUntil: 'domcontentloaded' });
    await waitFor(async () => (await ui.fab(page)).length > 0, { what: 'кнопка' });
    await openPanel(page);
    await clickButton(page, 'Новая загрузка');
    await clickButton(page, 'Выбрать, что скачать');
    await waitFor(async () => (await ui.scope(page)) === 'folder', { what: 'выбрана папка «Видео»' });
    await ui.setChecked(page, 'skipDone', false);
    await clickButton(page, 'Начать скачивание');
    await waitJobDone(page, /^Папка «Видео»$/);
    const obj = await s3Get(s3Port, 'disk/Яндекс Диск/Видео/Отпуск 2019.mov');
    check('в S3: Видео/Отпуск 2019.mov (20 МБ) совпадает с оригиналом', obj.status === 200 && obj.body.equals(content('/disk/Видео/Отпуск 2019.mov')), `HTTP ${obj.status}, ${obj.body.length} байт`);
    check('файл ушёл по частям (multipart)', mock.state.s3Log.some((l) => l.includes('?uploads')) && mock.state.s3Log.some((l) => /partNumber=2/.test(l)), mock.state.s3Log.join(' | '));
    check('все подписи S3 сошлись с независимым расчётом (aws4)', mock.state.s3SignatureErrors.length === 0, mock.state.s3SignatureErrors.join(' | '));
    check('cookie сессии отправлялись и при переносе', mock.state.cookieMissing === 0, `без cookie: ${mock.state.cookieMissing}`);

    // ---------- 7. Выделенное — сразу в ZIP-архив ----------
    console.log('\n7. Выделенное в «Фото» — сразу в ZIP-архив');
    const zipRoot = path.join(downloads, root);
    const zipsBefore = new Set(listFiles(zipRoot).filter((f) => f.endsWith('.zip')));
    const newZips = () => listFiles(zipRoot).filter((f) => f.endsWith('.zip') && !zipsBefore.has(f));
    const looseBefore = listFiles(downloads).filter((f) => !f.endsWith('.zip'));
    await page.goto('https://disk.yandex.ru/client/disk/%D0%A4%D0%BE%D1%82%D0%BE', { waitUntil: 'domcontentloaded' });
    await waitFor(async () => (await ui.fab(page)).length > 0, { what: 'кнопка' });
    await openPanel(page);
    await clickButton(page, 'Новая загрузка');
    await clickButton(page, 'Выбрать, что скачать');
    await waitFor(async () => (await ui.scope(page)) === 'selection', { what: 'выбрано «Выделенное»' });
    check('в «Куда сохранить» есть ZIP-архив', /ZIP-архивом на этот компьютер/.test(await ui.text(page)));
    await ui.choose(page, 'dest', 'zip');
    check('для архива показан выбор размера частей', /Делить большой архив на части по/.test(await ui.text(page)));
    await ui.setChecked(page, 'skipDone', false);
    await clickButton(page, 'Начать скачивание');
    await waitJobDone(page, /^Выделенное в «Фото»: 2$/);
    const panel7 = await ui.text(page);
    const zips7 = newZips();
    check('сохранён один архив без номера части', zips7.length === 1 && /^Фото \(выбранное\) \d{4}-\d\d-\d\d \d\d-\d\d\.zip$/.test(zips7[0]), zips7.join(', '));
    if (zips7.length === 1) {
      const { entries } = readZip(fs.readFileSync(path.join(zipRoot, zips7[0])));
      const byName = new Map(entries.map((e) => [e.name, e]));
      check('в архиве ровно выделенное, папки сохранены', JSON.stringify([...byName.keys()].sort()) === JSON.stringify(['2019/A.JPG', '2019/a (2).jpg', 'IMG_001.jpg']), [...byName.keys()].join(', '));
      const same = (name, remote) => byName.has(name) && byName.get(name).data.equals(content(remote));
      check('файлы в архиве совпадают с оригиналами', same('2019/A.JPG', '/disk/Фото/2019/A.JPG') && same('2019/a (2).jpg', '/disk/Фото/2019/a.jpg') && same('IMG_001.jpg', '/disk/Фото/IMG_001.jpg'));
      check('даты файлов взяты с Диска', byName.has('IMG_001.jpg') && byName.get('IMG_001.jpg').mtime === mtimeOf('/disk/Фото/IMG_001.jpg'), String(byName.get('IMG_001.jpg')?.mtime));
      check('фото в архиве не пережимаются', entries.every((e) => e.method === 0));
    }
    check('отдельные файлы на компьютер не сохранялись', JSON.stringify(listFiles(downloads).filter((f) => !f.endsWith('.zip'))) === JSON.stringify(looseBefore));
    check('в панели: «Сохранено в архив: 3»', /Сохранено в архив: 3/.test(panel7), panel7);
    check('в панели показано, где архив', /В «Загрузках»: архив/.test(panel7), panel7);

    // ---------- 8. Папка в архив частями, текст сжимается ----------
    console.log('\n8. Папка «Документы» в ZIP по частям: сжатие, повтор сбоя, «мёртвый» файл');
    await sw.evaluate(() =>
      chrome.storage.local.set({
        'ydd:timing': { startMs: 4000, firstByteMs: 4000, stallMs: 4000, retryDelayMs: 500, pollMs: 500, flushMs: 200, slowFactor: 1, zipPartBytes: 1 },
      })
    );
    zipsBefore.clear();
    for (const f of listFiles(zipRoot)) if (f.endsWith('.zip')) zipsBefore.add(f);
    await page.goto('https://disk.yandex.ru/client/disk/%D0%94%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D1%8B', { waitUntil: 'domcontentloaded' });
    await waitFor(async () => (await ui.fab(page)).length > 0, { what: 'кнопка' });
    await openPanel(page);
    await clickButton(page, 'Новая загрузка');
    await clickButton(page, 'Выбрать, что скачать');
    await waitFor(async () => (await ui.scope(page)) === 'folder', { what: 'выбрана папка' });
    const destDefault = await page.evaluate(() => document.querySelector('ydd-download-all').shadowRoot.querySelector('input[name=dest]:checked')?.value);
    check('архив запомнился как выбор по умолчанию', destDefault === 'zip', destDefault);
    await ui.setChecked(page, 'skipDone', false);
    await clickButton(page, 'Начать скачивание');
    await waitJobDone(page, /^Папка «Документы»$/);
    const zips8 = newZips().sort();
    check('архив сохранён частями «…, часть N.zip»', zips8.length === 2 && zips8.every((f) => /^Документы \d{4}-\d\d-\d\d \d\d-\d\d, часть \d\.zip$/.test(f)), zips8.join(', '));
    const all8 = new Map();
    for (const f of zips8) for (const e of readZip(fs.readFileSync(path.join(zipRoot, f))).entries) all8.set(e.name, e);
    check(
      'каждая часть открывается сама по себе, вместе — все доступные файлы',
      JSON.stringify([...all8.keys()].sort()) === JSON.stringify(['Документы/flaky.pdf', 'Документы/Глубоко/Ещё глубже/файл.txt']),
      [...all8.keys()].join(', ')
    );
    const deep = all8.get('Документы/Глубоко/Ещё глубже/файл.txt');
    check('текст в архиве сжат', deep && deep.method === 8 && deep.packed < deep.size / 3 && deep.data.equals(content('/disk/Документы/Глубоко/Ещё глубже/файл.txt')), deep ? `${deep.size} → ${deep.packed}` : 'нет файла');
    const pdf = all8.get('Документы/flaky.pdf');
    check('сбойный файл попал в архив со второй попытки', pdf && pdf.data.equals(content('/disk/Документы/flaky.pdf')));
    check('нет недосохранённых частей', !listFiles(downloads).some((f) => f.endsWith('.crdownload')));
    const panel8 = await ui.text(page);
    check('в панели: 2 части архива и 2 ошибки', /2 части архива/.test(panel8) && /Не удалось: 2/.test(panel8), panel8);

    // ---------- 9. Выбор файлов и папок в панели ----------
    console.log('\n9. Выбор вручную: файлы и папки из разных мест');
    await sw.evaluate(() =>
      chrome.storage.local.set({
        'ydd:timing': { startMs: 4000, firstByteMs: 4000, stallMs: 4000, retryDelayMs: 500, pollMs: 500, flushMs: 200, slowFactor: 1 },
      })
    );
    await page.goto('https://disk.yandex.ru/client/disk', { waitUntil: 'domcontentloaded' });
    await waitFor(async () => (await ui.fab(page)).length > 0, { what: 'кнопка' });
    await openPanel(page);
    await clickButton(page, 'Новая загрузка');
    await clickButton(page, 'Выбрать, что скачать');
    await waitFor(async () => (await ui.scopes(page)).includes('pick'), { what: 'пункт «Выбрать файлы и папки»' });
    await ui.choose(page, 'scope', 'pick');
    await pickerWaitFor(page, 'readme.txt');
    check('список выбора открылся с корня Диска', (await picker.names(page)).includes('Фото'));
    await picker.row(page, 'readme.txt', 'toggle');
    await picker.row(page, 'Документы', 'open');
    await pickerWaitFor(page, 'Глубоко');
    await picker.row(page, 'Глубоко', 'open');
    await pickerWaitFor(page, 'Ещё глубже');
    await picker.row(page, 'Ещё глубже', 'toggle');
    await picker.crumb(page, 'Диск');
    await pickerWaitFor(page, 'Фото');
    await picker.row(page, 'Фото', 'open');
    await pickerWaitFor(page, 'IMG_005.jpg');
    check('большая папка показывается порциями', !(await picker.names(page)).includes('IMG_044.jpg'));
    await picker.more(page);
    await pickerWaitFor(page, 'IMG_044.jpg');
    check('«Показать ещё» догружает остальное', true);
    await picker.row(page, '2019', 'toggle');
    await picker.row(page, 'IMG_005.jpg', 'toggle');
    await picker.row(page, '2019', 'open');
    await pickerWaitFor(page, 'A.JPG');
    const inside = await picker.row(page, 'A.JPG');
    check('файлы внутри отмеченной папки отмечены и заблокированы', inside && inside.checked && inside.disabled, JSON.stringify(inside));
    const summary9 = await picker.summary(page);
    check('итог выбора: 2 папки и 2 файла', summary9 === 'Выбрано: 2 папки и 2 файла', summary9);
    await clickButton(page, 'Готово');
    await waitFor(async () => (await ui.scope(page)) === 'pick', { what: 'возврат к настройке с выбранным' });
    check('в настройке: «Выбрано вручную: 2 папки и 2 файла»', /Выбрано вручную: 2 папки и 2 файла/.test(await ui.text(page)));
    await ui.choose(page, 'dest', 'local');
    await ui.setChecked(page, 'skipDone', false);
    const before9 = Object.assign({}, mock.state.downloads);
    const delta = (p) => (mock.state.downloads[p] || 0) - (before9[p] || 0);
    await clickButton(page, 'Начать скачивание');
    await waitJobDone(page, /^Выбрано: 2 папки и 2 файла$/);
    const wanted9 = ['/disk/readme.txt', '/disk/Документы/Глубоко/Ещё глубже/файл.txt', '/disk/Фото/2019/A.JPG', '/disk/Фото/2019/a.jpg', '/disk/Фото/IMG_005.jpg'];
    check('скачано ровно отмеченное', wanted9.every((p) => delta(p) === 1), wanted9.map((p) => `${p}: ${delta(p)}`).join(', '));
    const extra9 = Object.keys(mock.state.downloads).filter((p) => !wanted9.includes(p) && delta(p) > 0);
    check('ничего лишнего не скачано', extra9.length === 0, extra9.join(', '));
    check('файлы легли в те же папки, что на Диске', fs.readFileSync(path.join(downloads, root, 'Документы', 'Глубоко', 'Ещё глубже', 'файл.txt')).equals(content('/disk/Документы/Глубоко/Ещё глубже/файл.txt')) && fs.readFileSync(path.join(downloads, root, 'Фото', 'IMG_005.jpg')).equals(content('/disk/Фото/IMG_005.jpg')));

    // ---------- 10. То же выбранное — в архив ----------
    console.log('\n10. То же выбранное — в ZIP-архив');
    zipsBefore.clear();
    for (const f of listFiles(zipRoot)) if (f.endsWith('.zip')) zipsBefore.add(f);
    await clickButton(page, 'Новая загрузка');
    await clickButton(page, 'Выбрать, что скачать');
    await waitFor(async () => (await ui.scope(page)) === 'pick', { what: 'выбранное вручную сохранилось' });
    check('выбранное вручную не сбрасывается', true);
    await ui.choose(page, 'dest', 'zip');
    await ui.setChecked(page, 'skipDone', false);
    await clickButton(page, 'Начать скачивание');
    await waitJobDone(page, /^Выбрано: 2 папки и 2 файла$/);
    const zips10 = newZips();
    check('архив назван по выбранному', zips10.length === 1 && /^Яндекс Диск \(выбранное\) \d{4}-\d\d-\d\d \d\d-\d\d\.zip$/.test(zips10[0]), zips10.join(', '));
    if (zips10.length === 1) {
      const names10 = readZip(fs.readFileSync(path.join(zipRoot, zips10[0]))).entries.map((e) => e.name).sort();
      const expect10 = ['readme.txt', 'Документы/Глубоко/Ещё глубже/файл.txt', 'Фото/2019/A.JPG', 'Фото/2019/a (2).jpg', 'Фото/IMG_005.jpg'].sort();
      check('в архиве — отмеченное с папками от общего корня', JSON.stringify(names10) === JSON.stringify(expect10), names10.join(', '));
    }

    // ---------- 11. Только нужные типы файлов ----------
    console.log('\n11. Фильтр по типам: сначала поиск, потом только .pdf и .mov, затем ещё .txt');
    await clickButton(page, 'Новая загрузка');
    await clickButton(page, 'Выбрать, что скачать');
    await waitFor(async () => (await ui.scopes(page)).includes('all'), { what: 'настройка' });
    await ui.choose(page, 'scope', 'all');
    await ui.choose(page, 'types', 'ask');
    await ui.choose(page, 'dest', 'local');
    await ui.setChecked(page, 'skipDone', false);
    const before11 = Object.assign({}, mock.state.downloads);
    const delta11 = (p) => (mock.state.downloads[p] || 0) - (before11[p] || 0);
    await clickButton(page, 'Начать скачивание');
    const types = () =>
      page.evaluate(() => {
        const root = document.querySelector('ydd-download-all').shadowRoot;
        return {
          groups: [...root.querySelectorAll('input[data-group]')].map((i) => i.dataset.group),
          exts: [...root.querySelectorAll('li[data-ext]')].map((li) => [li.dataset.ext, li.querySelector('.psize').textContent]),
          summary: root.querySelector('.pfoot .big')?.textContent || '',
        };
      });
    await waitFor(async () => (await types()).groups.length > 0, { what: 'окно выбора типов', timeout: 60000 });
    const t11 = await types();
    check('ничего не скачано, пока типы не выбраны', Object.keys(mock.state.downloads).every((p) => delta11(p) === 0));
    check('найдены группы: фото, видео, документы, другое', JSON.stringify(t11.groups) === '["photo","video","docs","other"]', JSON.stringify(t11.groups));
    const extMap = Object.fromEntries(t11.exts);
    check('найдены типы с количеством файлов', /^53 ·/.test(extMap.jpg || '') && /^7 ·/.test(extMap.txt || '') && /^9 ·/.test(extMap.bin || '') && /^1 ·/.test(extMap[''] || ''), JSON.stringify(extMap));
    const tick = (ext) =>
      page.evaluate((e) => document.querySelector('ydd-download-all').shadowRoot.querySelector(`input[data-ext="${e}"]`).click(), ext);
    await tick('pdf');
    await tick('mov');
    const sum11 = (await types()).summary;
    check('итог: «Будет скачано: 2 файла»', /^Будет скачано: 2 файла · 20/.test(sum11), sum11);
    await clickButton(page, 'Скачать выбранные типы');
    await waitJobDone(page, /^Весь Диск$/);
    check('скачаны только .pdf и .mov', delta11('/disk/Документы/flaky.pdf') === 1 && delta11('/disk/Видео/Отпуск 2019.mov') === 1, `pdf ${delta11('/disk/Документы/flaky.pdf')}, mov ${delta11('/disk/Видео/Отпуск 2019.mov')}`);
    const other11 = Object.keys(mock.state.downloads).filter((p) => !/flaky\.pdf|Отпуск 2019\.mov/.test(p) && delta11(p) > 0);
    check('остальные типы не скачивались', other11.length === 0, other11.join(', '));
    check('в панели показан фильтр и сколько файлов пропущено', /Только: \.mov, \.pdf\./.test(await ui.text(page)) && /Другие типы, не скачиваются: \d+/.test(await ui.text(page)), await ui.text(page));
    await clickButton(page, 'Изменить типы');
    await waitFor(async () => (await types()).groups.length > 0, { what: 'окно выбора типов снова' });
    await tick('txt');
    await clickButton(page, 'Скачать выбранные типы');
    const txt11 = ['/disk/readme.txt', '/disk/CON.txt', '/disk/Отчёт: итоги?.txt', '/disk/копия~1.txt', '/disk/Документы/Глубоко/Ещё глубже/файл.txt', '/disk/Медленно/fast.txt', '/disk/Аварийные/после.txt'];
    // Задание было закончено — ждём, пока оно снова начнётся и закончится.
    await waitFor(async () => txt11.every((p) => delta11(p) >= 1), { what: 'докачка .txt', timeout: 60000 }).catch(() => {});
    await waitJobDone(page, /^Весь Диск$/);
    check('добавленный тип .txt докачан в том же задании', txt11.every((p) => delta11(p) === 1), txt11.map((p) => `${p}: ${delta11(p)}`).join(', '));
    check('уже скачанные .pdf и .mov заново не качались', delta11('/disk/Документы/flaky.pdf') === 1 && delta11('/disk/Видео/Отпуск 2019.mov') === 1);
    check('фото не скачивались', !Object.keys(mock.state.downloads).some((p) => /\.jpe?g$/i.test(p) && delta11(p) > 0));

    // ---------- 12. Язык интерфейса ----------
    console.log('\n12. Язык: выбор в панели, запоминается, тот же язык на странице настроек');
    const extName = await sw.evaluate(() => chrome.i18n.getMessage('extName'));
    check('название расширения берётся из _locales', ['Скачать всё с Яндекс Диска', 'Download All from Yandex Disk'].includes(extName), extName);
    const langOf = () =>
      page.evaluate(() => {
        const root = document.querySelector('ydd-download-all').shadowRoot;
        const sel = root.querySelector('select.lang');
        return { value: sel.value, count: sel.options.length, badge: root.querySelector('.badge')?.textContent || '', fab: root.querySelector('.fab .label').textContent };
      });
    const pickLang = (code) =>
      page.evaluate((c) => {
        const sel = document.querySelector('ydd-download-all').shadowRoot.querySelector('select.lang');
        sel.value = c;
        sel.dispatchEvent(new Event('change'));
      }, code);
    const ru12 = await langOf();
    check('по языку браузера выбран русский, в списке 23 языка', ru12.value === 'ru' && ru12.count === 23, JSON.stringify(ru12));
    await pickLang('en');
    await waitFor(async () => (await langOf()).badge === 'Done', { what: 'панель на английском', timeout: 10000 }).catch(() => {});
    const en12 = await langOf();
    check('после выбора English панель и кнопка — на английском', en12.badge === 'Done' && /^Done/.test(en12.fab) && /New download…/.test(await ui.text(page)), JSON.stringify(en12));
    await pickLang('kk');
    await waitFor(async () => /^Дайын/.test(await ui.fab(page)), { what: 'казахский', timeout: 10000 }).catch(() => {});
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(async () => /^Дайын/.test(await ui.fab(page)), { what: 'казахский после перезагрузки', timeout: 20000 }).catch(() => {});
    check('выбранный язык (казахский) запомнился после перезагрузки', /^Дайын/.test(await ui.fab(page)), await ui.fab(page));
    // В Chrome у казахского урезанные данные о числах: без явного образца было бы «20.5 КБ».
    // В окне типов общий размер дробный: «Табылды: 74 файл (20,5 МБ)».
    await openPanel(page);
    await clickButton(page, 'Түрлерді өзгерту');
    const body12 = () => page.evaluate(() => document.querySelector('ydd-download-all').shadowRoot.querySelector('.panel .body').innerText);
    await waitFor(async () => /Табылды:/.test(await body12()), { what: 'окно типов по-казахски', timeout: 10000 }).catch(() => {});
    const kk12 = await body12();
    check('числа по-казахски записаны как «20,5 МБ», а не «20.5 МБ»', /\d,\d\s(КБ|МБ)\)/.test(kk12) && !/\d\.\d+\s(КБ|МБ)/.test(kk12), kk12.slice(0, 300));
    await clickButton(page, 'Артқа');
    const optionsPage = await browser.newPage();
    await optionsPage.goto(new URL('options.html', swTarget.url()).href);
    await optionsPage.waitForFunction(() => document.documentElement.dataset.ready === 'true', { timeout: 10000 }).catch(() => {});
    const opt12 = await optionsPage.evaluate(() => ({
      h1: document.querySelector('h1').textContent,
      note: document.getElementById('translation-note').hidden ? '' : document.getElementById('translation-note').textContent,
    }));
    check('страница настроек облака тоже на казахском, с пометкой о переводе', opt12.h1 === 'Файлдарды қайда көшіру керек' && /Орыс тілінен/.test(opt12.note), JSON.stringify(opt12));
    await optionsPage.close();
    await openPanel(page);
    await pickLang('ru');
    await waitFor(async () => /^Готово/.test(await ui.fab(page)), { what: 'снова русский', timeout: 10000 }).catch(() => {});
    check('вернули русский — без пометки о переводе', /^Готово/.test(await ui.fab(page)) && !/Перевод|Translated/.test(await ui.text(page)), await ui.fab(page));

    // ---------- 13. Один большой файл: процент растёт по байтам ----------
    // Раньше процент считался только по готовым файлам: одно большое видео весь час показывало «0 %».
    console.log('\n13. Один медленный файл: процент на кнопке растёт по ходу скачивания');
    await clickButton(page, 'Новая загрузка');
    await clickButton(page, 'Выбрать, что скачать');
    await ui.choose(page, 'scope', 'pick');
    if (await ui.click(page, 'Изменить выбор')) {
      await page.evaluate(() => [...document.querySelector('ydd-download-all').shadowRoot.querySelectorAll('details.psel li button')].forEach((b) => b.click()));
    }
    if (!(await picker.names(page)).includes('slow.bin')) {
      await pickerWaitFor(page, 'Медленно');
      await picker.row(page, 'Медленно', 'open');
    }
    await pickerWaitFor(page, 'slow.bin');
    await picker.row(page, 'slow.bin', 'toggle');
    const picked13 = await picker.summary(page);
    await clickButton(page, 'Готово');
    await ui.choose(page, 'dest', 'local');
    await ui.setChecked(page, 'skipDone', false);
    await clickButton(page, 'Начать скачивание');
    await sleep(300);
    const started13 = (await ui.text(page)).replace(/\n+/g, ' | ').slice(0, 300);
    const labels13 = [];
    for (let i = 0; i < 300; i++) {
      const l = await ui.fab(page);
      if (labels13[labels13.length - 1] !== l) labels13.push(l);
      if (/^Готово/.test(l)) break;
      await sleep(100);
    }
    const mid13 = labels13.map((l) => /Скачивание · (\d+)%/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
    check('у единственного файла процент растёт, а не стоит на 0 % до конца', mid13.some((p) => p > 0 && p < 100), `${labels13.join(' → ')}; выбрано: ${picked13}; после старта: ${started13}`);
  } finally {
    await s3.close().catch(() => {});
    await browser.close().catch(() => {});
    await mock.close();
    if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log('Файлы теста оставлены в', tmp);
  }

  if (logs.length) console.log('\nСообщения из браузера:\n' + logs.join('\n'));
  const failed = results.filter((r) => !r.ok);
  console.log(`\nИтого: ${results.length - failed.length} из ${results.length} проверок пройдено.`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error('\nТест прерван:', e.message);
  process.exitCode = 1;
});
