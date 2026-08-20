'use strict';
const fs = require('fs');
const path = require('path');
const { fetchJson, downloadFile, request, readBody } = require('../net');

const MODRINTH = 'https://api.modrinth.com/v2';
const CURSEFORGE = 'https://api.curseforge.com/v1';

// classId в CurseForge: 6 — моды, 12 — ресурспаки, 6552 — шейдеры, 4471 — сборки
const CF_CLASS = { mod: 6, resourcepack: 12, shader: 6552, modpack: 4471 };
const CF_LOADER = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

const TARGET_DIR = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', modpack: 'mods' };

function asList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v).trim()).filter(Boolean);
}

/**
 * Категории Modrinth по типам проектов. Набор фиксированный и задан самим сервисом,
 * поэтому держим его здесь, а не тянем отдельным запросом при каждом открытии каталога.
 * У CurseForge своя система категорий — там фильтр по ним не предлагается.
 */
const MODRINTH_CATEGORIES = {
  mod: [
    ['adventure', 'Приключения'], ['cursed', 'Странное'], ['decoration', 'Декор'],
    ['economy', 'Экономика'], ['equipment', 'Снаряжение'], ['food', 'Еда'],
    ['game-mechanics', 'Механики'], ['library', 'Библиотеки'], ['magic', 'Магия'],
    ['management', 'Управление'], ['minigame', 'Мини-игры'], ['mobs', 'Мобы'],
    ['optimization', 'Оптимизация'], ['social', 'Общение'], ['storage', 'Хранение'],
    ['technology', 'Техника'], ['transportation', 'Транспорт'], ['utility', 'Утилиты'],
    ['worldgen', 'Генерация мира'],
  ],
  resourcepack: [
    ['audio', 'Звук'], ['blocks', 'Блоки'], ['combat', 'Бой'], ['core-shaders', 'Core-шейдеры'],
    ['decoration', 'Декор'], ['entities', 'Существа'], ['environment', 'Окружение'],
    ['equipment', 'Снаряжение'], ['fonts', 'Шрифты'], ['gui', 'Интерфейс'], ['items', 'Предметы'],
    ['locale', 'Локализация'], ['modded', 'Для модов'], ['models', 'Модели'],
    ['realistic', 'Реализм'], ['simplistic', 'Минимализм'], ['tweaks', 'Правки'],
    ['utility', 'Утилиты'], ['vanilla-like', 'В духе ванили'],
  ],
  shader: [
    ['atmosphere', 'Атмосфера'], ['bloom', 'Свечение'], ['cartoon', 'Мультяшные'],
    ['colored-lighting', 'Цветной свет'], ['fantasy', 'Фэнтези'], ['foliage', 'Листва'],
    ['path-tracing', 'Path tracing'], ['pbr', 'PBR'], ['realistic', 'Реализм'],
    ['reflections', 'Отражения'], ['semi-realistic', 'Полуреализм'], ['shadows', 'Тени'],
    ['vanilla-like', 'В духе ванили'],
  ],
  modpack: [
    ['adventure', 'Приключения'], ['challenging', 'Сложные'], ['combat', 'Бой'],
    ['kitchen-sink', 'Всего понемногу'], ['lightweight', 'Лёгкие'], ['magic', 'Магия'],
    ['multiplayer', 'Для игры вместе'], ['optimization', 'Оптимизация'],
    ['quests', 'Задания'], ['technology', 'Техника'],
  ],
};

function shorten(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/* ----------------------------- Modrinth ----------------------------- */

async function searchModrinth({ query, gameVersion, loader, projectType = 'mod', limit = 30, offset = 0, sort = 'relevance', categories = [] }) {
  const facets = [['project_type:' + projectType]];
  if (gameVersion) facets.push(['versions:' + gameVersion]);
  // Ресурспаки и шейдеры не привязаны к загрузчику
  if (loader && loader !== 'vanilla' && projectType === 'mod') facets.push(['categories:' + loader]);
  // Каждая выбранная категория — отдельная группа: между собой они складываются по И
  for (const c of asList(categories)) facets.push(['categories:' + c]);

  const params = new URLSearchParams({
    query: query || '',
    facets: JSON.stringify(facets),
    limit: String(limit),
    offset: String(offset),
    index: sort,
  });
  const data = await fetchJson(MODRINTH + '/search?' + params.toString());

  return {
    total: data.total_hits || 0,
    items: (data.hits || []).map((h) => ({
      source: 'modrinth',
      id: h.project_id,
      slug: h.slug,
      name: h.title,
      summary: shorten(h.description, 160),
      author: h.author,
      downloads: h.downloads || 0,
      followers: h.follows || 0,
      icon: h.icon_url || null,
      categories: h.categories || [],
      updated: h.date_modified,
      gameVersions: h.versions || [],
      link: 'https://modrinth.com/' + projectType + '/' + h.slug,
    })),
  };
}

async function modrinthVersions(projectId, gameVersion, loader) {
  const params = new URLSearchParams();
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
  if (loader && loader !== 'vanilla') params.set('loaders', JSON.stringify([loader]));
  const qs = params.toString();
  const list = await fetchJson(MODRINTH + '/project/' + encodeURIComponent(projectId) + '/version' + (qs ? '?' + qs : ''));

  return (list || []).map((v) => ({
    source: 'modrinth',
    id: v.id,
    projectId: v.project_id,
    name: v.name,
    versionNumber: v.version_number,
    channel: v.version_type,
    gameVersions: v.game_versions || [],
    loaders: v.loaders || [],
    published: v.date_published,
    dependencies: (v.dependencies || []).map((d) => ({
      projectId: d.project_id,
      versionId: d.version_id,
      type: d.dependency_type,
    })),
    file: pickModrinthFile(v.files),
  })).filter((v) => v.file);
}

function pickModrinthFile(files) {
  const list = files || [];
  const primary = list.find((f) => f.primary) || list[0];
  if (!primary) return null;
  return {
    url: primary.url,
    filename: primary.filename,
    size: primary.size,
    sha1: primary.hashes && primary.hashes.sha1,
  };
}

/* ---------------------------- CurseForge ---------------------------- */

async function cfRequest(pathname, apiKey) {
  if (!apiKey) {
    const err = new Error('Для CurseForge нужен API-ключ. Получите его на console.curseforge.com и вставьте в Настройки.');
    err.code = 'NO_CF_KEY';
    throw err;
  }
  const { res, status } = await request(CURSEFORGE + pathname, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
  });
  const text = (await readBody(res)).toString('utf8');
  if (status === 403 || status === 401) throw new Error('CurseForge отклонил API-ключ — проверьте его в настройках');
  if (status >= 400) throw new Error('CurseForge вернул ошибку ' + status);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('CurseForge вернул некорректный ответ');
  }
}

async function searchCurseForge({ query, gameVersion, loader, projectType = 'mod', limit = 30, offset = 0, sort = 'relevance' }, apiKey) {
  const params = new URLSearchParams({
    gameId: '432',
    classId: String(CF_CLASS[projectType] || CF_CLASS.mod),
    searchFilter: query || '',
    pageSize: String(Math.min(limit, 50)),
    index: String(offset),
    sortOrder: 'desc',
    sortField: sort === 'downloads' ? '6' : sort === 'updated' ? '3' : '2',
  });
  if (gameVersion) params.set('gameVersion', gameVersion);
  if (loader && CF_LOADER[loader] && projectType === 'mod') params.set('modLoaderType', String(CF_LOADER[loader]));

  const data = await cfRequest('/mods/search?' + params.toString(), apiKey);
  return {
    total: (data.pagination && data.pagination.totalCount) || 0,
    items: (data.data || []).map((m) => ({
      source: 'curseforge',
      id: String(m.id),
      slug: m.slug,
      name: m.name,
      summary: shorten(m.summary, 160),
      author: (m.authors && m.authors[0] && m.authors[0].name) || 'неизвестен',
      downloads: m.downloadCount || 0,
      followers: m.thumbsUpCount || 0,
      icon: (m.logo && m.logo.thumbnailUrl) || null,
      categories: (m.categories || []).map((c) => c.slug),
      updated: m.dateModified,
      gameVersions: [...new Set((m.latestFilesIndexes || []).map((f) => f.gameVersion).filter(Boolean))],
      link: (m.links && m.links.websiteUrl) || null,
    })),
  };
}

async function curseforgeVersions(modId, gameVersion, loader, apiKey) {
  const params = new URLSearchParams({ pageSize: '50' });
  if (gameVersion) params.set('gameVersion', gameVersion);
  if (loader && CF_LOADER[loader]) params.set('modLoaderType', String(CF_LOADER[loader]));

  const data = await cfRequest('/mods/' + encodeURIComponent(modId) + '/files?' + params.toString(), apiKey);
  return (data.data || []).map((f) => ({
    source: 'curseforge',
    id: String(f.id),
    projectId: String(modId),
    name: f.displayName,
    versionNumber: f.fileName,
    channel: f.releaseType === 1 ? 'release' : f.releaseType === 2 ? 'beta' : 'alpha',
    gameVersions: f.gameVersions || [],
    loaders: (f.gameVersions || []).filter((v) => CF_LOADER[String(v).toLowerCase()]).map((v) => String(v).toLowerCase()),
    published: f.fileDate,
    dependencies: (f.dependencies || [])
      .filter((d) => d.relationType === 3) // 3 = обязательная зависимость
      .map((d) => ({ projectId: String(d.modId), type: 'required' })),
    file: {
      // downloadUrl бывает null, если автор запретил стороннее скачивание
      url: f.downloadUrl || cfFallbackUrl(f.id, f.fileName),
      filename: f.fileName,
      size: f.fileLength,
      sha1: (f.hashes || []).find((h) => h.algo === 1) ? (f.hashes.find((h) => h.algo === 1).value) : null,
      blocked: !f.downloadUrl,
    },
  })).filter((v) => v.file && v.file.url);
}

function cfFallbackUrl(fileId, fileName) {
  const id = String(fileId);
  return 'https://edge.forgecdn.net/files/' + id.slice(0, 4) + '/' + Number(id.slice(4)) + '/' + fileName;
}

/* ------------------------------ Общее ------------------------------- */

async function search(opts, settings) {
  if (opts.source === 'curseforge') return searchCurseForge(opts, settings && settings.curseforgeKey);
  return searchModrinth(opts);
}

async function versions(opts, settings) {
  if (opts.source === 'curseforge') {
    return curseforgeVersions(opts.projectId, opts.gameVersion, opts.loader, settings && settings.curseforgeKey);
  }
  return modrinthVersions(opts.projectId, opts.gameVersion, opts.loader);
}

/**
 * Скачивает мод в папку сборки и, для Modrinth, тянет обязательные зависимости.
 * Возвращает список фактически установленных файлов.
 */
async function install({ version, instanceDir, projectType = 'mod', gameVersion, loader, withDependencies = true }, settings, onProgress) {
  const report = onProgress || (() => {});
  const dir = path.join(instanceDir, TARGET_DIR[projectType] || 'mods');
  fs.mkdirSync(dir, { recursive: true });

  const installed = [];
  const queue = [{ version, depth: 0 }];
  const seenProjects = new Set([version.projectId]);

  while (queue.length) {
    const { version: current, depth } = queue.shift();
    const file = current.file;
    if (!file || !file.url) continue;

    const dest = path.join(dir, file.filename);
    report({ label: 'Загрузка ' + file.filename, done: installed.length, total: installed.length + queue.length + 1 });
    await downloadFile(file.url, dest, { sha1: file.sha1, size: file.size, attempts: 3 });

    installed.push({
      source: current.source,
      projectId: current.projectId,
      versionId: current.id,
      name: current.name,
      filename: file.filename,
      path: dest,
      projectType,
      dependency: depth > 0,
      installedAt: Date.now(),
    });

    // Зависимости тянем только на один уровень вглубь — этого хватает и не уводит в лавину
    if (!withDependencies || depth >= 2) continue;
    for (const dep of current.dependencies || []) {
      if (dep.type !== 'required' || !dep.projectId || seenProjects.has(dep.projectId)) continue;
      seenProjects.add(dep.projectId);
      try {
        const list = await versions(
          { source: current.source, projectId: dep.projectId, gameVersion, loader },
          settings
        );
        const best = list.find((v) => v.channel === 'release') || list[0];
        if (best) queue.push({ version: best, depth: depth + 1 });
      } catch {
        // недоступная зависимость не должна ломать установку основного мода
      }
    }
  }

  report({ label: 'Готово', done: installed.length, total: installed.length });
  return installed;
}

/** Читает реально лежащие в папке сборки файлы — источник правды вместо записей в конфиге. */
function listInstalled(instanceDir) {
  const result = [];
  for (const [type, sub] of Object.entries(TARGET_DIR)) {
    if (type === 'modpack') continue;
    const dir = path.join(instanceDir, sub);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!/\.(jar|zip)(\.disabled)?$/i.test(name)) continue;
      let size = 0;
      try { size = fs.statSync(path.join(dir, name)).size; } catch { /* файл исчез */ }
      result.push({
        filename: name,
        projectType: type,
        path: path.join(dir, name),
        enabled: !name.endsWith('.disabled'),
        size,
      });
    }
  }
  return result;
}

function toggle(filePath, enabled) {
  const disabled = filePath.endsWith('.disabled');
  if (enabled && disabled) {
    const next = filePath.slice(0, -'.disabled'.length);
    fs.renameSync(filePath, next);
    return next;
  }
  if (!enabled && !disabled) {
    const next = filePath + '.disabled';
    fs.renameSync(filePath, next);
    return next;
  }
  return filePath;
}

function remove(filePath) {
  fs.rmSync(filePath, { force: true });
}

/** Категории для фильтра в интерфейсе. */
function categoriesOf(projectType) {
  return (MODRINTH_CATEGORIES[projectType] || []).map(([id, label]) => ({ id, label }));
}

module.exports = { search, versions, install, listInstalled, toggle, remove, categoriesOf, TARGET_DIR };
