'use strict';
/*
 * Вёрстка панели на всех языках — на компьютере и на экране телефона.
 *
 *   cd tests/e2e && npm install && npm run layout
 *   SHOTS=/папка/для/скриншотов npm run layout    — заодно снимки каждого вида на каждом языке
 *
 * 23 языка × несколько видов глазами не пересмотришь, поэтому ищем то, что ломается чаще всего:
 * панель или кнопка шире экрана, текст и кнопки, вылезающие за край панели, прокрутка вбок.
 * Диск поддельный, как в run.js: в интернет ничего не уходит.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer');
const mock = require('./mock-yandex');

const EXT = path.resolve(__dirname, '..', '..', 'extension');
const LOCALES = path.join(EXT, 'locales');
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODES = fs
  .readdirSync(LOCALES)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .sort((a, b) => (a === 'ru' ? -1 : b === 'ru' ? 1 : a.localeCompare(b)));
const DICT = Object.fromEntries(CODES.map((c) => [c, JSON.parse(fs.readFileSync(path.join(LOCALES, c + '.json'), 'utf8'))]));
const tr = (code, key) => DICT[code][key] || DICT.ru[key];

const DEVICES = {
  computer: { viewport: { width: 1280, height: 860, deviceScaleFactor: 1 } },
  phone: {
    viewport: { width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  },
};

const problems = [];
let checks = 0;

function cert(dir) {
  const cfg = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(
    cfg,
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=disk.yandex.ru\n[ext]\nsubjectAltName=DNS:disk.yandex.ru,DNS:*.disk.yandex.ru,DNS:*.storage.yandex.net,DNS:cloud-api.yandex.net\n'
  );
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-config', cfg], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
}

/** Что вылезает за край панели или экрана. Пустой список — всё на месте. */
function overflowIn(page) {
  return page.evaluate(() => {
    const root = document.querySelector('ydd-download-all').shadowRoot;
    const panel = root.querySelector('.panel');
    const out = [];
    const vw = document.documentElement.clientWidth;
    const pr = panel.getBoundingClientRect();
    if (pr.left < -0.5 || pr.right > vw + 0.5) out.push(`панель за краем экрана (${Math.round(pr.left)}…${Math.round(pr.right)} при ширине ${vw})`);
    const fr = root.querySelector('.fab').getBoundingClientRect();
    if (fr.left < -0.5 || fr.right > vw + 0.5) out.push('плавающая кнопка за краем экрана');
    if (panel.scrollWidth > panel.clientWidth + 1) out.push(`прокрутка вбок: ${panel.scrollWidth} > ${panel.clientWidth}`);
    const left = pr.left + panel.clientLeft;
    const right = left + panel.clientWidth;
    const reported = [];
    for (const el of panel.querySelectorAll('*')) {
      if (!el.getClientRects().length || reported.some((r) => r.contains(el))) continue;
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      const by = Math.max(r.right - right, left - r.left);
      if (by > 0.5) {
        reported.push(el);
        const cls = typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '';
        out.push(`${el.tagName.toLowerCase()}${cls} «${(el.textContent || el.value || '').trim().slice(0, 50)}» вылезает на ${Math.round(by)} px`);
      }
    }
    return out;
  });
}

async function shoot(page, device, file) {
  if (!SHOTS) return;
  await page.evaluate(() => (document.querySelector('ydd-download-all').shadowRoot.querySelector('.panel').scrollTop = 0));
  if (device === 'phone') return page.screenshot({ path: path.join(SHOTS, file) });
  const box = await page.evaluate(() => {
    const s = document.querySelector('ydd-download-all').shadowRoot;
    const a = s.querySelector('.panel').getBoundingClientRect();
    const b = s.querySelector('.fab').getBoundingClientRect();
    return { x: Math.min(a.x, b.x) - 12, y: Math.max(0, a.y - 12), width: Math.max(a.right, b.right) - Math.min(a.x, b.x) + 24, height: b.bottom - a.y + 24 };
  });
  return page.screenshot({ path: path.join(SHOTS, file), clip: box });
}

const inPanel = (page, fn, ...args) =>
  page.evaluate(
    (src, a) => new Function('root', 'args', src)(document.querySelector('ydd-download-all').shadowRoot, a),
    `return (${fn})(root, ...args)`,
    args
  );
const clickText = (page, text) =>
  page.waitForFunction(
    (t) => {
      const b = [...document.querySelector('ydd-download-all').shadowRoot.querySelectorAll('.panel button')].find((x) => x.textContent.trim().startsWith(t) && !x.disabled);
      if (b) b.click();
      return !!b;
    },
    { polling: 150, timeout: 15000 },
    text
  );
const choose = (page, name, value) =>
  inPanel(
    page,
    (root, n, v) => {
      const el = root.querySelector(`input[name="${n}"][value="${v}"]`);
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    name,
    value
  );

async function useLang(page, code) {
  await inPanel(
    page,
    (root, c) => {
      const sel = root.querySelector('select.lang');
      sel.value = c;
      sel.dispatchEvent(new Event('change'));
    },
    code
  );
  await page.waitForFunction(
    (w) => document.querySelector('ydd-download-all').shadowRoot.querySelector('header .title').textContent === w,
    { polling: 100, timeout: 10000 },
    tr(code, 'app.title')
  );
}

/** Один вид панели на всех языках: переключаем язык, ждём перерисовки, меряем. */
async function everyLang(page, device, view, ready = async () => {}) {
  const bad = [];
  for (const code of CODES) {
    await useLang(page, code);
    await ready();
    await sleep(80);
    checks++;
    for (const p of await overflowIn(page)) bad.push(`${code}: ${p}`);
    await shoot(page, device, `${device}-${view}-${code}.png`);
  }
  await useLang(page, 'ru');
  problems.push(...bad.map((b) => `${device} · ${view} · ${b}`));
  console.log(`  ${bad.length ? '✗' : '✓'} ${view}: ${bad.length ? 'замечаний: ' + bad.length : 'языков: ' + CODES.length + ', ничего не вылезает'}`);
}

async function checkDevice(device, port) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ydd-layout-'));
  const profile = path.join(tmp, 'profile');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'dl'));
  fs.writeFileSync(
    path.join(profile, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: path.join(tmp, 'dl'), prompt_for_download: false },
      intl: { accept_languages: 'ru-RU,ru', selected_languages: 'ru-RU,ru' },
    })
  );
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    pipe: true,
    enableExtensions: [EXT],
    userDataDir: profile,
    args: [
      `--host-resolver-rules=MAP disk.yandex.ru 127.0.0.1:${port},MAP *.disk.yandex.ru 127.0.0.1:${port},MAP *.storage.yandex.net 127.0.0.1:${port},MAP cloud-api.yandex.net 127.0.0.1:${port}`,
      '--ignore-certificate-errors',
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
    ],
  });
  console.log(`\n${device === 'phone' ? 'Телефон, 360 × 740' : 'Компьютер, 1280 × 860'}`);
  try {
    const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
    const sw = await swTarget.worker();
    await sw.evaluate(() =>
      chrome.storage.local.set({ 'ydd:timing': { startMs: 3000, firstByteMs: 3000, stallMs: 3000, retryDelayMs: 300, pollMs: 300, flushMs: 200, slowFactor: 1 } })
    );
    const page = await browser.newPage();
    const { viewport, ua } = DEVICES[device];
    if (ua) await page.setUserAgent(ua);
    await page.setViewport(viewport);
    await page.goto('https://disk.yandex.ru/client/disk/%D0%A4%D0%BE%D1%82%D0%BE', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('ydd-download-all')?.shadowRoot?.querySelector('.fab .label')?.textContent, { polling: 200, timeout: 20000 });
    await inPanel(page, (root) => root.querySelector('.fab').click());
    await page.waitForFunction(() => !document.querySelector('ydd-download-all').shadowRoot.querySelector('.panel').hidden, { polling: 100 });

    await choose(page, 'dest', 'local');
    await everyLang(page, device, 'настройка');
    await choose(page, 'dest', 'zip');
    await everyLang(page, device, 'настройка-zip');

    const listed = () =>
      page.waitForFunction(() => document.querySelector('ydd-download-all').shadowRoot.querySelectorAll('ul.plist li.pitem').length > 0, { polling: 100, timeout: 15000 });
    await choose(page, 'scope', 'pick');
    await listed();
    await everyLang(page, device, 'выбор-файлов', listed);
    await clickText(page, tr('ru', 'common.cancel'));

    // Фильтр типов: поиск, окно типов, затем скачивание с ошибками (мёртвые файлы) — для списка ошибок.
    await choose(page, 'scope', 'all');
    await choose(page, 'types', 'ask');
    await choose(page, 'dest', 'local');
    await clickText(page, tr('ru', 'setup.start'));
    const typesShown = () =>
      page.waitForFunction(() => document.querySelector('ydd-download-all').shadowRoot.querySelectorAll('input[data-group]').length > 0, { polling: 150, timeout: 60000 });
    await typesShown();
    await everyLang(page, device, 'типы-файлов', typesShown);
    await clickText(page, tr('ru', 'types.markAll'));
    await clickText(page, tr('ru', 'types.apply'));
    await sleep(500);
    await everyLang(page, device, 'ход-скачивания');
    await page.waitForFunction((w) => document.querySelector('ydd-download-all').shadowRoot.querySelector('.badge')?.textContent === w, { polling: 300, timeout: 300000 }, tr('ru', 'badge.done'));
    await everyLang(page, device, 'готово');
    await clickText(page, tr('ru', 'action.new'));
    await page.waitForFunction(() => document.querySelector('ydd-download-all').shadowRoot.querySelector('.panel').innerText.includes('?'), { polling: 150, timeout: 10000 }).catch(() => {});
    await everyLang(page, device, 'новая-загрузка');

    // Страница настроек облака.
    const options = await browser.newPage();
    if (ua) await options.setUserAgent(ua);
    await options.setViewport(viewport);
    await options.goto(new URL('options.html', swTarget.url()).href, { waitUntil: 'domcontentloaded' });
    await options.waitForFunction(() => document.documentElement.dataset.ready === 'true', { polling: 100 });
    await options.evaluate(() => {
      const r = document.getElementById('kind-s3');
      r.checked = true;
      r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const bad = [];
    for (const code of CODES) {
      await options.evaluate(async (c) => {
        const sel = document.getElementById('lang');
        sel.value = c;
        sel.dispatchEvent(new Event('change'));
      }, code);
      await options.waitForFunction((w) => document.querySelector('h1').textContent === w, { polling: 100, timeout: 10000 }, tr(code, 'opt.title'));
      checks++;
      const over = await options.evaluate(() => {
        const out = [];
        const vw = document.documentElement.clientWidth;
        if (document.documentElement.scrollWidth > vw + 1) out.push(`прокрутка вбок: ${document.documentElement.scrollWidth} > ${vw}`);
        for (const el of document.querySelectorAll('main *')) {
          if (!el.getClientRects().length) continue;
          const r = el.getBoundingClientRect();
          if (r.right > vw + 0.5) out.push(`${el.tagName.toLowerCase()} «${(el.textContent || '').trim().slice(0, 50)}» вылезает на ${Math.round(r.right - vw)} px`);
        }
        return out.slice(0, 5);
      });
      for (const p of over) bad.push(`${code}: ${p}`);
      if (SHOTS) await options.screenshot({ path: path.join(SHOTS, `${device}-настройки-облака-${code}.png`), fullPage: device === 'phone' });
    }
    problems.push(...bad.map((b) => `${device} · настройки облака · ${b}`));
    console.log(`  ${bad.length ? '✗' : '✓'} настройки облака: ${bad.length ? 'замечаний: ' + bad.length : 'языков: ' + CODES.length + ', ничего не вылезает'}`);
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ydd-layout-cert-'));
  mock.configure({ options: { rateLimit: false } });
  const server = await mock.startMock(cert(tmp));
  try {
    for (const device of process.env.DEVICE ? [process.env.DEVICE] : Object.keys(DEVICES)) await checkDevice(device, server.port);
  } finally {
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (problems.length) console.log('\nЗамечания:\n' + problems.map((p) => '  ' + p).join('\n'));
  console.log(`\nИтого: проверено видов — ${checks}, замечаний — ${problems.length}.${SHOTS ? ' Снимки: ' + SHOTS : ''}`);
  process.exitCode = problems.length ? 1 : 0;
}

main().catch((e) => {
  console.error('\nПроверка прервана:', e.message);
  process.exitCode = 1;
});
