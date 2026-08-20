'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');
const { store } = require('./store');
const fabric = require('./mc/loaders/fabric');
const forge = require('./mc/loaders/forge');
const { installVersion } = require('./mc/install');

const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];

const LOADER_LABEL = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
};

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Имя папки сборки делаем строго ASCII.
 * Кириллица в пути ломает часть модов с нативными библиотеками и некоторые версии Java,
 * поэтому отображаемое имя оставляем как есть, а на диске транслитерируем.
 */
function slug(name) {
  const base = String(name || 'instance')
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ''))
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 32)
    .replace(/^-|-$/g, '');
  return (base || 'instance') + '-' + crypto.randomBytes(3).toString('hex');
}

/** Список версий загрузчика под выбранную версию игры. */
async function loaderVersions(loader, mcVersion) {
  if (loader === 'vanilla') return [];
  if (loader === 'fabric' || loader === 'quilt') return fabric.loaderVersions(loader, mcVersion);
  if (loader === 'forge') return forge.listForge(mcVersion);
  if (loader === 'neoforge') return forge.listNeoForge(mcVersion);
  throw new Error('Неизвестный загрузчик: ' + loader);
}

/** Ставит профиль загрузчика и возвращает id версии, которую нужно запускать. */
async function installLoader(loader, mcVersion, loaderVersion, onProgress, settings) {
  if (loader === 'vanilla') return { versionId: mcVersion, loaderVersion: null };
  if (loader === 'fabric' || loader === 'quilt') {
    return fabric.install(loader, mcVersion, loaderVersion, onProgress);
  }
  if (loader === 'forge' || loader === 'neoforge') {
    return forge.install(loader, mcVersion, loaderVersion, onProgress, settings);
  }
  throw new Error('Неизвестный загрузчик: ' + loader);
}

/**
 * Создаёт сборку: ставит загрузчик, готовит изолированную папку игры.
 * Файлы игры при этом уже полностью скачаны, поэтому первый запуск мгновенный.
 */
async function create({ name, mcVersion, loader = 'vanilla', loaderVersion = null, icon = null }, onProgress) {
  if (!mcVersion) throw new Error('Не выбрана версия Minecraft');
  if (!LOADERS.includes(loader)) throw new Error('Неизвестный загрузчик: ' + loader);
  const report = onProgress || (() => {});

  const title = String(name || '').trim() || (LOADER_LABEL[loader] + ' ' + mcVersion);
  const id = slug(title);

  const resolvedLoader = await installLoader(loader, mcVersion, loaderVersion, report, store.settings);
  await installVersion(resolvedLoader.versionId, report, store.settings);

  const dir = P.instanceDir(id);
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'saves'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'resourcepacks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'shaderpacks'), { recursive: true });

  const instance = {
    id,
    name: title,
    mcVersion,
    loader,
    loaderVersion: resolvedLoader.loaderVersion || loaderVersion || null,
    versionId: resolvedLoader.versionId,
    icon: icon || null,
    dir,
    createdAt: Date.now(),
    lastPlayed: null,
    playTime: 0,
    overrides: {},
  };
  store.upsertInstance(instance);
  report({ stage: 'done', label: 'Сборка готова', done: 1, total: 1 });
  return instance;
}

/** Переустанавливает файлы версии — лечит повреждённые библиотеки и ассеты. */
async function repair(id, onProgress) {
  const inst = store.getInstance(id);
  if (!inst) throw new Error('Сборка не найдена');
  await installVersion(inst.versionId, onProgress, store.settings);
  return inst;
}

function remove(id, deleteFiles) {
  const inst = store.getInstance(id);
  if (!inst) return false;
  if (deleteFiles) {
    try { fs.rmSync(P.instanceDir(id), { recursive: true, force: true }); }
    catch { throw new Error('Не удалось удалить папку сборки — закройте игру и файловые менеджеры'); }
  }
  store.removeInstance(id);
  return true;
}

function duplicate(id, newName) {
  const src = store.getInstance(id);
  if (!src) throw new Error('Сборка не найдена');
  const copyId = slug(newName || src.name + ' копия');
  const dest = P.instanceDir(copyId);
  fs.cpSync(P.instanceDir(id), dest, { recursive: true });
  const clone = {
    ...src,
    id: copyId,
    name: newName || src.name + ' (копия)',
    dir: dest,
    createdAt: Date.now(),
    lastPlayed: null,
    playTime: 0,
  };
  store.upsertInstance(clone);
  return clone;
}

/** Дополняет сборки для UI: размер папки и наличие модов считаем на лету. */
function list() {
  return store.instances.list.map((inst) => {
    const dir = P.instanceDir(inst.id);
    let modCount = 0;
    try {
      modCount = fs.readdirSync(path.join(dir, 'mods')).filter((f) => /\.jar$/i.test(f)).length;
    } catch {
      modCount = 0;
    }
    return { ...inst, dir, modCount, loaderLabel: LOADER_LABEL[inst.loader] || inst.loader };
  });
}

module.exports = { create, remove, duplicate, list, repair, loaderVersions, installLoader, LOADERS, LOADER_LABEL };
