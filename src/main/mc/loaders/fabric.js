'use strict';
const fs = require('fs');
const P = require('../../paths');
const { fetchJson } = require('../../net');

// Fabric и Quilt используют одинаковый формат meta-API, отличается только базовый URL.
const ENDPOINTS = {
  fabric: 'https://meta.fabricmc.net/v2',
  quilt: 'https://meta.quiltmc.org/v3',
};

function base(kind) {
  const url = ENDPOINTS[kind];
  if (!url) throw new Error('Неизвестный загрузчик: ' + kind);
  return url;
}

/** Версии Minecraft, поддерживаемые загрузчиком. */
async function gameVersions(kind) {
  const list = await fetchJson(base(kind) + '/versions/game');
  return list.map((v) => ({ id: v.version, stable: Boolean(v.stable) }));
}

/** Версии самого загрузчика для конкретной версии игры. */
async function loaderVersions(kind, mcVersion) {
  const list = await fetchJson(base(kind) + '/versions/loader/' + encodeURIComponent(mcVersion));
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(kind + ' не поддерживает Minecraft ' + mcVersion);
  }
  return list.map((entry) => ({
    version: entry.loader.version,
    stable: Boolean(entry.loader.stable),
    build: entry.loader.build,
  }));
}

/**
 * Ставит профиль загрузчика: скачивает готовый version.json с inheritsFrom.
 * Библиотеки докачает общий установщик — здесь только метаданные.
 */
async function install(kind, mcVersion, loaderVersion, onProgress) {
  const report = onProgress || (() => {});
  report({ stage: 'loader', label: 'Профиль ' + kind, done: 0, total: 1 });

  let version = loaderVersion;
  if (!version) {
    const list = await loaderVersions(kind, mcVersion);
    const stable = list.find((l) => l.stable) || list[0];
    version = stable.version;
  }

  const url = base(kind) + '/versions/loader/' + encodeURIComponent(mcVersion) + '/' +
    encodeURIComponent(version) + '/profile/json';
  const profile = await fetchJson(url);
  if (!profile || !profile.id || !profile.mainClass) {
    throw new Error('Некорректный профиль ' + kind + ' для ' + mcVersion);
  }
  if (!profile.inheritsFrom) profile.inheritsFrom = mcVersion;

  const dir = P.versionDir(profile.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(P.versionJson(profile.id), JSON.stringify(profile, null, 2), 'utf8');

  report({ stage: 'loader', label: 'Профиль ' + kind + ' готов', done: 1, total: 1 });
  return { versionId: profile.id, loaderVersion: version };
}

module.exports = { gameVersions, loaderVersions, install, ENDPOINTS };
