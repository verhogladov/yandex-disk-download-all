'use strict';
/*
 * Проверка переводов: node scripts/check-locales.js [код языка…]
 * Сверяет каждый словарь из extension/locales с русским: все ли строки есть,
 * совпадают ли подстановки {…}, есть ли форма множественного числа other,
 * и нет ли слов, где смешаны алфавиты (латинская «a» среди кириллицы и т. п.).
 */
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'extension', 'locales');
const ru = JSON.parse(fs.readFileSync(path.join(dir, 'ru.json'), 'utf8'));
const vars = (s) => [...new Set(String(s).match(/\{(\w+)\}/g) || [])].sort().join(',');
const forms = (v) => (v && typeof v === 'object' ? Object.values(v) : [v]);
const SCRIPTS = ['Latin', 'Cyrillic', 'Armenian', 'Georgian'].map((s) => [s, new RegExp(`\\p{Script=${s}}`, 'u')]);
const mixed = (s) =>
  String(s)
    .split(/[^\p{L}\p{M}]+/u)
    .filter((word) => SCRIPTS.filter(([, re]) => re.test(word)).length > 1);

const codes = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'ru.json').map((f) => f.slice(0, -5));

let failed = 0;
for (const code of codes) {
  let dict;
  try {
    dict = JSON.parse(fs.readFileSync(path.join(dir, code + '.json'), 'utf8'));
  } catch (e) {
    console.log(`${code}: не читается — ${e.message}`);
    failed++;
    continue;
  }
  const problems = [];
  for (const key of Object.keys(ru)) {
    if (!(key in dict)) {
      problems.push(`нет строки ${key}`);
      continue;
    }
    const want = vars(forms(ru[key])[0]);
    for (const form of forms(dict[key])) {
      if (typeof form !== 'string') problems.push(`${key}: не строка`);
      else if (vars(form) !== want) problems.push(`${key}: подстановки «${vars(form)}» вместо «${want}»`);
      for (const word of mixed(form)) problems.push(`${key}: смешаны алфавиты в слове «${word}»`);
    }
    if (ru[key] && typeof ru[key] === 'object' && dict[key] && typeof dict[key] === 'object' && !('other' in dict[key])) {
      problems.push(`${key}: нет формы other`);
    }
  }
  for (const key of Object.keys(dict)) if (!(key in ru)) problems.push(`лишняя строка ${key}`);
  if (problems.length) failed++;
  console.log(`${code}: ${problems.length ? problems.length + ' замечаний\n  ' + problems.join('\n  ') : 'всё на месте'}`);
}
process.exitCode = failed ? 1 : 0;
