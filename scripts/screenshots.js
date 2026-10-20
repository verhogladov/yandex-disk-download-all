'use strict';
/*
 * Скриншоты для сайта и README на правдоподобном демо-Диске (поддельный сервер из tests/e2e).
 *   (cd tests/e2e && npm install) && NODE_PATH=tests/e2e/node_modules node scripts/screenshots.js
 * Картинки сохраняются в docs/. SETUP_ONLY=1 — только панели выбора, без долгого скачивания.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer');
const mock = require('../tests/e2e/mock-yandex');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Демо-Диск ------------------------------------------------------------------------
function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}
function size(seed, min, max) {
  return Math.round(min + ((seed * 2654435761) % 1000) / 1000 * (max - min));
}
const files = [];
for (let i = 0; i < 640; i++) {
  const d = new Date(Date.UTC(2023, 5, 1) + i * 3.7 * 3600 * 1000);
  const name = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(i % 60)}.jpg`;
  files.push([`/disk/Фотокамера/${name}`, { mediatype: 'image', size: size(i, 2.2 * MB, 6.5 * MB), slow: i % 45 === 20, dead: i === 333 || i === 401 }]);
}
for (let i = 0; i < 180; i++) files.push([`/disk/Фото/2019 Отпуск/IMG_${4012 + i}.JPG`, { mediatype: 'image', size: size(i + 7, 3 * MB, 7 * MB), dead: i === 77 }]);
for (let i = 0; i < 220; i++) files.push([`/disk/Фото/Свадьба Ани и Миши/DSC_${pad(i + 1, 4)}.JPG`, { mediatype: 'image', size: size(i + 3, 6 * MB, 12 * MB) }]);
for (let i = 0; i < 24; i++) files.push([`/disk/Фото/Обои/wallpaper-${i + 1}.png`, { mediatype: 'image', size: size(i, 1 * MB, 4 * MB) }]);
for (const [n, s] of [
  ['Договор аренды.pdf', 1.2],
  ['Квитанции 2025.xlsx', 0.3],
  ['Налоговый вычет 2024.pdf', 2.1],
  ['Резюме.docx', 0.1],
  ['Паспорт, скан.pdf', 3.4],
]) {
  files.push([`/disk/Документы/${n}`, { size: Math.round(s * MB) }]);
}
for (const [n, s, dead] of [
  ['Выпускной 2019.mp4', 1840, false],
  ['Первые шаги.MOV', 652, false],
  ['Новый год 2023.mp4', 2410, true],
]) {
  files.push([`/disk/Видео/${n}`, { mediatype: 'video', size: s * MB, dead }]);
}
for (let i = 0; i < 40; i++) files.push([`/disk/Музыка/Трек ${pad(i + 1)}.mp3`, { mediatype: 'audio', size: size(i, 6 * MB, 11 * MB) }]);
const unlim = Array.from({ length: 280 }, (_, i) => `/photounlim/2021-${pad((i % 12) + 1)}-${pad((i % 27) + 1)} 12-${pad(i % 60)}-${pad((i * 7) % 60)}.jpg`);
const clusters = Array.from({ length: 28 }, (_, c) => ({ id: `c${pad(c, 3)}`, items: unlim.slice(c * 10, c * 10 + 10) }));
const totalBytes = files.reduce((s, [, o]) => s + (o.size || 0), 0) + unlim.length * 3 * MB;

mock.configure({
  files,
  emptyDirs: [],
  unlim,
  clusters,
  options: {
    rateLimit: false,
    unlimSize: 3 * MB,
    space: { files_count: files.length + unlim.length, used: totalBytes, trash: 0, photounlim: unlim.length * 3 * MB },
    selection: {
      '/disk/Фото': [
        ['2019 Отпуск', 'dir', true],
        ['Свадьба Ани и Миши', 'dir', true],
        ['Обои', 'dir', false],
      ],
    },
  },
});

// --- Браузер ----------------------------------------------------------------------------
function cert(dir) {
  const cfg = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(
    cfg,
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=disk.yandex.ru\n[ext]\nsubjectAltName=DNS:disk.yandex.ru,DNS:*.disk.yandex.ru,DNS:downloader.disk.yandex.ru,DNS:*.downloader.disk.yandex.ru,DNS:*.storage.yandex.net,DNS:cloud-api.yandex.net\n'
  );
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-config', cfg], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ydd-shots-'));
  const downloads = path.join(tmp, 'dl');
  fs.mkdirSync(path.join(tmp, 'profile', 'Default'), { recursive: true });
  fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(tmp, 'profile', 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false }, intl: { accept_languages: 'ru-RU,ru' } }));
  const server = await mock.startMock(cert(tmp));
  const p = server.port;
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    enableExtensions: [path.join(ROOT, 'extension')],
    userDataDir: path.join(tmp, 'profile'),
    args: [
      `--host-resolver-rules=MAP disk.yandex.ru 127.0.0.1:${p},MAP *.disk.yandex.ru 127.0.0.1:${p},MAP *.storage.yandex.net 127.0.0.1:${p},MAP cloud-api.yandex.net 127.0.0.1:${p}`,
      '--ignore-certificate-errors',
      // Без этого на Mac со спящим экраном браузер ждёт кадровую синхронизацию и не рисует страницу.
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
    ],
  });
  try {
    const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker');
    const sw = await swTarget.worker();
    await sw.evaluate(() =>
      chrome.storage.local.set({
        'ydd:timing': { startMs: 5000, firstByteMs: 3000, stallMs: 3000, retryDelayMs: 300, pollMs: 400, flushMs: 300, slowFactor: 1 },
        'ydd:dest': { type: 'webdav', label: 'WebDAV · cloud.home.ru' },
      })
    );
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
    const root = 'document.querySelector("ydd-download-all").shadowRoot';
    const shot = async (name) => {
      await page.bringToFront();
      for (const dark of [false, true]) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
        await page.evaluate(
          (d, r) => {
            document.body.style.background = d ? '#16181c' : '#ffffff';
            eval(r).querySelector('.wrap').classList.toggle('dark', d);
          },
          dark,
          root
        );
        await sleep(250);
        const box = await page.evaluate((r) => {
          const s = eval(r);
          const a = s.querySelector('.panel').getBoundingClientRect();
          const b = s.querySelector('.fab').getBoundingClientRect();
          return { x: Math.min(a.x, b.x) - 16, y: a.y - 16, w: Math.max(a.right, b.right) - Math.min(a.x, b.x) + 32, h: b.bottom - a.y + 32 };
        }, root);
        await page.screenshot({ path: path.join(OUT, `${name}${dark ? '-dark' : ''}.png`), clip: { x: box.x, y: Math.max(0, box.y), width: box.w, height: box.h } });
      }
      console.log('  ', name);
    };
    const click = (sel) => page.evaluate((s, r) => eval(r).querySelector(s).click(), sel, root);
    const text = () => page.evaluate((r) => eval(r).querySelector('.panel .body').innerText, root);

    await page.bringToFront();
    await page.goto('https://disk.yandex.ru/client/disk/%D0%A4%D0%BE%D1%82%D0%BE', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('ydd-download-all')?.shadowRoot, { polling: 200 });
    await sleep(400);
    await click('.fab');
    await sleep(300);
    await click('input[name=scope][value=all]');
    await sleep(200);
    await shot('setup');

    // Выделенное — одним ZIP-архивом.
    await click('input[name=scope][value=selection]');
    await click('input[name=dest][value=zip]');
    await sleep(250);
    await shot('zip-setup');

    // Выбор файлов и папок вручную: папка целиком и несколько фото из другой папки.
    const rowAction = (name, action) =>
      page.evaluate(
        (n, a, r) => {
          const li = [...eval(r).querySelectorAll('ul.plist li.pitem')].find((x) => x.dataset.name === n);
          if (a === 'toggle') li.querySelector('input').click();
          else li.querySelector('button.pname').click();
        },
        name,
        action,
        root
      );
    const waitRow = (name) => page.waitForFunction((n, r) => [...eval(r).querySelectorAll('ul.plist li.pitem')].some((x) => x.dataset.name === n), { polling: 200 }, name, root);
    await click('input[name=scope][value=pick]');
    await waitRow('Свадьба Ани и Миши');
    await rowAction('Свадьба Ани и Миши', 'toggle');
    await rowAction('2019 Отпуск', 'open');
    await waitRow('IMG_4012.JPG');
    for (const n of ['IMG_4012.JPG', 'IMG_4015.JPG', 'IMG_4016.JPG']) await rowAction(n, 'toggle');
    await page.evaluate((r) => (eval(r).querySelector('.panel').scrollTop = 0), root);
    await sleep(250);
    await shot('picker');
    await page.evaluate((r) => [...eval(r).querySelectorAll('button')].find((b) => b.textContent === 'Отмена').click(), root);
    await sleep(200);
    await click('input[name=scope][value=all]');
    if (process.env.SETUP_ONLY) return;

    // Для хода скачивания — на компьютер.
    await click('input[name=dest][value=local]');
    await page.evaluate((r) => [...eval(r).querySelectorAll('button')].find((b) => b.textContent.startsWith('Начать')).click(), root);
    const started = Date.now();
    for (;;) {
      const t = await text();
      const m = /(\d[\d\s]*) из (\d[\d\s]*)/.exec(t.replace(/ /g, ' '));
      const done = m ? Number(m[1].replace(/\s/g, '')) : 0;
      const total = m ? Number(m[2].replace(/\s/g, '')) : 1;
      const active = await page.evaluate((r) => [...eval(r).querySelectorAll('ul.active .p')].map((e) => e.textContent), root);
      if (!/Ищем файлы/.test(t) && done / total > 0.42 && active.some((a) => /\d+%/.test(a) && !/100%/.test(a))) break;
      if (Date.now() - started > 600000) throw new Error('не дождались середины скачивания');
      await sleep(150);
    }
    await shot('progress');
    for (let i = 0, end = Date.now() + 900000; ; i++) {
      if ((await page.evaluate((r) => eval(r).querySelector('.badge')?.textContent, root)) === 'Готово') break;
      if (Date.now() > end) throw new Error('не дождались завершения:\n' + (await text()));
      if (i % 20 === 0) console.log('   …', (await text()).split('\n').slice(1, 6).join(' | '));
      await sleep(1000);
    }
    await sleep(400);
    await shot('done');

    // Страница настроек облака.
    const options = await browser.newPage();
    await options.setViewport({ width: 900, height: 1180, deviceScaleFactor: 2 });
    await options.bringToFront();
    await options.goto(`chrome-extension://${new URL(swTarget.url()).host}/options.html`, { waitUntil: 'domcontentloaded' });
    await options.waitForFunction(() => document.documentElement.dataset.ready === 'true', { polling: 200 });
    await options.evaluate(() => {
      document.getElementById('kind-webdav').checked = true;
      document.getElementById('kind-webdav').dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('dav-url').value = 'https://cloud.home.ru/remote.php/dav/files/anna/Яндекс Диск';
      document.getElementById('dav-user').value = 'anna';
      document.getElementById('dav-pass').value = 'app-password-12345';
      const status = document.getElementById('status');
      status.hidden = false;
      status.className = 'status ok';
      status.textContent = 'Подключение работает: WebDAV · cloud.home.ru. Нажмите «Сохранить».';
    });
    await options.screenshot({ path: path.join(OUT, 'cloud-settings.png'), fullPage: true });
    console.log('   cloud-settings');
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
