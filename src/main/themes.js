'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const { fetchJson, downloadFile } = require('./net');

/**
 * Картинки для тем берём только из источников со свободными лицензиями:
 *   NASA — медиатека агентства целиком в общественном достоянии;
 *   Wikimedia Commons — с фильтром по «public domain» и CC0.
 *
 * Случайные гифки из интернета сознательно не используются: это чужие авторские
 * права и ссылки, которые отвалятся через полгода. Скачанное кладётся в папку
 * лаунчера, поэтому дальше тема работает офлайн.
 */
const THEME_PHOTOS = {
  // Несколько запросов подряд: если по первому ничего свободного не нашлось, идём дальше
  space: { source: 'nasa', queries: ['nebula hubble', 'galaxy deep field', 'nebula'] },
  nature: { source: 'wikimedia', queries: ['mountain lake landscape forest', 'forest fog landscape', 'mountain landscape'] },
  racing: { source: 'wikimedia', queries: ['racing car speed motorsport', 'highway light trails night', 'race car circuit'] },
  // PvP и PvE остаются рисованными сценами — свободных картинок по теме
  // приемлемого качества нет, а брать арт Mojang нельзя
};

const FREE_LICENSES = /^(public domain|cc0|pd|no restrictions)/i;

function photoFile(themeId) {
  return path.join(P.backgrounds, 'theme-' + themeId + '.jpg');
}

function metaFile(themeId) {
  return path.join(P.backgrounds, 'theme-' + themeId + '.json');
}

function cached(themeId) {
  try {
    if (fs.statSync(photoFile(themeId)).size > 0) {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaFile(themeId), 'utf8')); } catch { /* без описания */ }
      return { themeId, ...meta };
    }
  } catch { /* нет файла */ }
  return null;
}

/* ------------------------------- Источники ------------------------------- */

async function findNasa(query) {
  const params = new URLSearchParams({ q: query, media_type: 'image', page_size: '30' });
  const data = await fetchJson('https://images-api.nasa.gov/search?' + params);
  const items = (data.collection && data.collection.items) || [];

  const candidates = [];
  for (const item of items) {
    const link = (item.links || [])[0];
    const info = (item.data || [])[0];
    if (!link || !link.href || !info) continue;
    // Ссылки в выдаче ведут на превью; полноразмерный вариант — ~orig
    const original = String(link.href).replace(/~(small|medium|thumb|large)\.jpg$/i, '~orig.jpg');
    if (!/~orig\.jpg$/i.test(original)) continue;
    candidates.push({ url: original, title: info.title || 'NASA', license: 'общественное достояние', author: 'NASA' });
    if (candidates.length >= 8) break;
  }
  return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
}

async function findWikimedia(query) {
  const params = new URLSearchParams({
    action: 'query', generator: 'search',
    gsrsearch: 'filetype:bitmap ' + query, gsrlimit: '30', gsrnamespace: '6',
    // 1600 по ширине хватает на весь экран и не раздувает файл до мегабайтов
    prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '1600', format: 'json',
  });
  const data = await fetchJson('https://commons.wikimedia.org/w/api.php?' + params);
  const pages = Object.values((data.query && data.query.pages) || {});

  const free = [];
  for (const page of pages) {
    const info = (page.imageinfo || [])[0];
    if (!info) continue;
    const md = info.extmetadata || {};
    const license = (md.LicenseShortName && md.LicenseShortName.value) || '';
    if (!FREE_LICENSES.test(license)) continue;   // берём только свободные без условий
    const url = info.thumburl || info.url;
    if (!url) continue;
    free.push({
      url,
      width: info.thumbwidth || 0,
      title: String(page.title || '').replace(/^File:/, ''),
      license,
      author: 'Wikimedia Commons',
    });
  }
  // Сначала самые крупные, затем случайная из лучших — чтобы «другая картинка» реально меняла фон
  free.sort((a, b) => b.width - a.width);
  const top = free.slice(0, 5);
  return top.length ? top[Math.floor(Math.random() * top.length)] : null;
}

/* -------------------------------- Загрузка ------------------------------- */

/**
 * Готовит картинку темы. Возвращает описание найденного изображения либо null,
 * если для темы картинка не предусмотрена или скачать её не вышло —
 * в этом случае интерфейс просто останется на нарисованной сцене.
 */
async function ensurePhoto(themeId, { force = false } = {}) {
  const recipe = THEME_PHOTOS[themeId];
  if (!recipe) return null;

  if (!force) {
    const have = cached(themeId);
    if (have) return have;
  }

  let found = null;
  for (const query of recipe.queries) {
    try {
      found = recipe.source === 'nasa' ? await findNasa(query) : await findWikimedia(query);
    } catch {
      found = null;   // сеть подвела — пробуем следующий запрос
    }
    if (found) break;
  }
  if (!found) return null;

  fs.mkdirSync(P.backgrounds, { recursive: true });
  await downloadFile(found.url, photoFile(themeId), { attempts: 2 });

  const meta = { title: found.title, license: found.license, author: found.author, url: found.url, at: Date.now() };
  fs.writeFileSync(metaFile(themeId), JSON.stringify(meta, null, 2), 'utf8');
  return { themeId, ...meta };
}

/** Картинка как data:-URI — renderer подставляет её в слой фона. */
function photo(themeId) {
  const file = photoFile(themeId);
  try {
    const buf = fs.readFileSync(file);
    const meta = cached(themeId) || {};
    return { dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64'), ...meta };
  } catch {
    return null;
  }
}

function clear(themeId) {
  try { fs.rmSync(photoFile(themeId), { force: true }); } catch { /* занят */ }
  try { fs.rmSync(metaFile(themeId), { force: true }); } catch { /* занят */ }
  return true;
}

function status() {
  const out = {};
  for (const id of Object.keys(THEME_PHOTOS)) out[id] = Boolean(cached(id));
  return out;
}

module.exports = { ensurePhoto, photo, clear, status, THEME_PHOTOS };
