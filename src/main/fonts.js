'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const { downloadFile } = require('./net');

/**
 * Шрифты берём с jsDelivr — это зеркало пакетов @fontsource,
 * то есть официальные файлы Google Fonts под открытыми лицензиями (OFL / Apache 2.0).
 * Скачиваются переменные (variable) версии: один файл покрывает все начертания,
 * поэтому вес интерфейса — десятки килобайт, а не мегабайты.
 */
const CDN = 'https://cdn.jsdelivr.net/npm/@fontsource-variable/';

// Диапазоны как у Google Fonts — браузер сам возьмёт нужный файл под каждый символ
const RANGES = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,'
    + 'U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  cyrillic: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
};

const SUBSETS = ['latin', 'cyrillic'];

const CATALOG = [
  {
    id: 'system', family: '', builtin: true,
    name: 'Системный', author: 'Windows', license: '—',
    note: 'Стандартный шрифт системы — ничего скачивать не нужно',
  },
  {
    // Шрифт Apple. Лицензия запрещает распространять его вместе с приложением,
    // поэтому он не скачивается, а подставляется системный — там, где он есть.
    id: 'sf', system: true,
    family: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue"',
    name: 'San Francisco', author: 'Apple', license: 'проприетарная',
    note: 'Системный шрифт macOS. Apple не разрешает распространять его для других систем, '
      + 'поэтому на Windows он появится только если установлен у вас вручную',
    appleOnly: true,
  },
  {
    id: 'inter', pkg: 'inter', family: 'Inter Variable',
    name: 'Inter', author: 'Rasmus Andersson', license: 'OFL 1.1',
    note: 'Спроектирован для экранов — самый нейтральный из современных',
  },
  {
    id: 'onest', pkg: 'onest', family: 'Onest Variable',
    name: 'Onest', author: 'Nikita Kanarev', license: 'OFL 1.1',
    note: 'Российский шрифт с продуманной кириллицей',
  },
  {
    id: 'manrope', pkg: 'manrope', family: 'Manrope Variable',
    name: 'Manrope', author: 'Mikhail Sharanda', license: 'OFL 1.1',
    note: 'Геометричный и лёгкий, хорошо смотрится в заголовках',
  },
  {
    id: 'rubik', pkg: 'rubik', family: 'Rubik Variable',
    name: 'Rubik', author: 'Hubert & Fischer', license: 'OFL 1.1',
    note: 'Со скруглёнными углами, мягкий и дружелюбный',
  },
  {
    id: 'montserrat', pkg: 'montserrat', family: 'Montserrat Variable',
    name: 'Montserrat', author: 'Julieta Ulanovsky', license: 'OFL 1.1',
    note: 'Широкий и заметный, с характерными формами',
  },
  {
    id: 'open-sans', pkg: 'open-sans', family: 'Open Sans Variable',
    name: 'Open Sans', author: 'Steve Matteson', license: 'OFL 1.1',
    note: 'Классика для длинных текстов, максимально привычный',
  },
  {
    id: 'nunito', pkg: 'nunito', family: 'Nunito Variable',
    name: 'Nunito', author: 'Vernon Adams', license: 'OFL 1.1',
    note: 'Округлый гуманистический гротеск',
  },
  {
    id: 'jetbrains-mono', pkg: 'jetbrains-mono', family: 'JetBrains Mono Variable',
    name: 'JetBrains Mono', author: 'JetBrains', license: 'OFL 1.1',
    note: 'Моноширинный — интерфейс станет похож на редактор кода',
  },
];

function fontDir(id) {
  return path.join(P.fonts, id);
}

function fileFor(id, subset) {
  return path.join(fontDir(id), subset + '.woff2');
}

function urlFor(entry, subset) {
  return CDN + entry.pkg + '@5/files/' + entry.pkg + '-' + subset + '-wght-normal.woff2';
}

function findEntry(id) {
  return CATALOG.find((f) => f.id === id) || null;
}

function isInstalled(entry) {
  if (entry.builtin || entry.system) return true;
  return SUBSETS.every((s) => {
    try { return fs.statSync(fileFor(entry.id, s)).size > 0; }
    catch { return false; }
  });
}

function installedSize(entry) {
  if (entry.builtin || entry.system) return 0;
  let total = 0;
  for (const s of SUBSETS) {
    try { total += fs.statSync(fileFor(entry.id, s)).size; } catch { /* нет файла */ }
  }
  return total;
}

function list() {
  return CATALOG.map((f) => ({
    id: f.id,
    name: f.name,
    author: f.author,
    license: f.license,
    note: f.note,
    family: f.family,
    builtin: Boolean(f.builtin),
    system: Boolean(f.system),
    appleOnly: Boolean(f.appleOnly),
    installed: isInstalled(f),
    size: installedSize(f),
  }));
}

async function install(id, onProgress) {
  const entry = findEntry(id);
  if (!entry) throw new Error('Неизвестный шрифт: ' + id);
  if (entry.builtin || entry.system) return { id, installed: true };

  const report = onProgress || (() => {});
  fs.mkdirSync(fontDir(id), { recursive: true });

  let done = 0;
  for (const subset of SUBSETS) {
    report({ stage: 'font', label: 'Загрузка шрифта ' + entry.name, done, total: SUBSETS.length });
    await downloadFile(urlFor(entry, subset), fileFor(id, subset), { attempts: 3 });
    done++;
  }
  report({ stage: 'font', label: 'Шрифт ' + entry.name + ' готов', done: SUBSETS.length, total: SUBSETS.length });
  return { id, installed: true, size: installedSize(entry) };
}

function remove(id) {
  const entry = findEntry(id);
  if (!entry || entry.builtin || entry.system) return false;
  fs.rmSync(fontDir(id), { recursive: true, force: true });
  return true;
}

/**
 * Отдаёт готовый CSS с @font-face. Файлы вшиваются как data:-URI —
 * так не нужен ни доступ к файловой системе из renderer, ни особый протокол,
 * а после скачивания шрифт работает полностью офлайн.
 */
function css(id) {
  const entry = findEntry(id);
  if (!entry || entry.builtin) return { css: '', family: '', stack: '' };
  // Системный шрифт подключать нечем — отдаём только стек имён
  if (entry.system) return { css: '', family: entry.name, stack: entry.family };
  if (!isInstalled(entry)) return { css: '', family: '', stack: '' };

  const faces = [];
  for (const subset of SUBSETS) {
    let data;
    try { data = fs.readFileSync(fileFor(id, subset)); }
    catch { continue; }
    faces.push(
      '@font-face{font-family:"' + entry.family + '";font-style:normal;font-display:swap;' +
      'font-weight:100 900;src:url(data:font/woff2;base64,' + data.toString('base64') + ') format("woff2");' +
      'unicode-range:' + RANGES[subset] + ';}'
    );
  }
  if (!faces.length) return { css: '', family: '', stack: '' };
  return { css: faces.join('\n'), family: entry.family, stack: '"' + entry.family + '"' };
}

module.exports = { list, install, remove, css, CATALOG, findEntry, isInstalled };
