'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const { store } = require('./store');
const instances = require('./instances');
const { installVersion } = require('./mc/install');

/**
 * Смена загрузчика у существующей сборки.
 *
 * Об атомарности. Копировать сборку во временную папку и подменять её после
 * успеха здесь не нужно и даже вредно: миры и ресурспаки весят гигабайты,
 * а смена загрузчика их вообще не касается. Достаточно понять, что именно
 * меняется, и убедиться, что каждое изменение либо происходит целиком,
 * либо не происходит:
 *
 *   1. Файлы игры и профили загрузчиков лежат в общих versions/ и libraries/.
 *      Установка нового профиля туда — добавление, а не замена: старый профиль
 *      остаётся нетронутым, и сборка продолжает запускаться на нём. Обрыв
 *      загрузки в худшем случае оставляет недокачанный профиль, на который
 *      никто не ссылается; повторная попытка докачает его.
 *
 *   2. Папка mods переносится переименованием — на одном томе это атомарная
 *      операция файловой системы.
 *
 *   3. Запись о сборке (какой загрузчик и какой versionId запускать) пишется
 *      последней и атомарно: store пишет во временный файл и делает rename.
 *
 * Точка невозврата — только шаг 3. Всё, что до него, оставляет сборку в старом
 * рабочем состоянии. Закрыли лаунчер на середине или пропала сеть — сборка
 * запускается как раньше.
 */

const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];

/** Что делать с модами при смене загрузчика. */
const MOD_ACTIONS = ['backup', 'delete', 'keep'];

function modsDir(instanceId) {
  return path.join(P.instanceDir(instanceId), 'mods');
}

function countMods(instanceId) {
  try {
    return fs.readdirSync(modsDir(instanceId))
      .filter((f) => /\.jar(\.disabled)?$/i.test(f)).length;
  } catch {
    return 0;
  }
}

/** Список загрузчиков, реально существующих для этой версии игры. */
async function availableLoaders(mcVersion) {
  const result = [{ id: 'vanilla', label: 'Vanilla', versions: [], available: true }];

  await Promise.all(LOADERS.filter((l) => l !== 'vanilla').map(async (loader) => {
    try {
      const versions = await instances.loaderVersions(loader, mcVersion);
      result.push({
        id: loader,
        label: instances.LOADER_LABEL[loader] || loader,
        versions: (versions || []).slice(0, 40),
        available: Boolean(versions && versions.length),
      });
    } catch (e) {
      // Загрузчика под эту версию нет — это обычное дело, а не сбой
      result.push({
        id: loader,
        label: instances.LOADER_LABEL[loader] || loader,
        versions: [],
        available: false,
        error: e.message,
      });
    }
  }));

  const order = LOADERS;
  return result.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/**
 * Что произойдёт при смене — показывается пользователю до того, как что-то
 * начнёт меняться. Отдельный шаг именно ради модов: моды Fabric с Forge
 * несовместимы и наоборот, автоматического преобразования не существует.
 */
function plan(instanceId, targetLoader) {
  const inst = store.getInstance(instanceId);
  if (!inst) throw new Error('Сборка не найдена');
  if (!LOADERS.includes(targetLoader)) throw new Error('Неизвестный загрузчик: ' + targetLoader);

  const mods = countMods(instanceId);
  const sameLoader = inst.loader === targetLoader;

  return {
    instanceId,
    name: inst.name,
    mcVersion: inst.mcVersion,
    from: { loader: inst.loader, label: instances.LOADER_LABEL[inst.loader] || inst.loader, version: inst.loaderVersion },
    to: { loader: targetLoader, label: instances.LOADER_LABEL[targetLoader] || targetLoader },
    mods,
    // Моды остаются совместимыми, только если загрузчик тот же
    modsCompatible: sameLoader,
    backupName: backupNameFor(instanceId, inst.loader),
    // Что сохранится в любом случае — это важно проговорить
    keeps: ['saves', 'options.txt', 'resourcepacks', 'shaderpacks', 'screenshots', 'config'],
  };
}

/** Имя папки для бэкапа модов, не затирающее предыдущий бэкап. */
function backupNameFor(instanceId, loader) {
  const base = 'mods_backup_' + (loader || 'vanilla');
  const dir = P.instanceDir(instanceId);
  if (!fs.existsSync(path.join(dir, base))) return base;
  for (let i = 2; i < 100; i++) {
    if (!fs.existsSync(path.join(dir, base + '_' + i))) return base + '_' + i;
  }
  return base + '_' + Date.now();
}

/** Переносит или удаляет моды. Возвращает, что было сделано. */
function handleMods(instanceId, action, oldLoader) {
  const dir = modsDir(instanceId);
  const total = countMods(instanceId);
  if (!total || action === 'keep') return { action: total ? 'keep' : 'none', moved: 0, to: null };

  if (action === 'delete') {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return { action: 'delete', moved: total, to: null };
  }

  // По умолчанию — бэкап: удалять чужие файлы без спроса нельзя
  const name = backupNameFor(instanceId, oldLoader);
  const dest = path.join(P.instanceDir(instanceId), name);
  fs.renameSync(dir, dest);   // на одном томе это атомарно
  fs.mkdirSync(dir, { recursive: true });
  return { action: 'backup', moved: total, to: name };
}

/**
 * Профиль версии больше никому не нужен — можно убрать.
 * Проверяем именно все сборки: versions/ общая, и профиль мог остаться
 * от другой сборки на том же загрузчике.
 */
function cleanupUnusedVersion(versionId) {
  if (!versionId) return false;
  // Ванильные версии не трогаем: их переиспользуют профили загрузчиков через inheritsFrom
  if (/^\d/.test(versionId)) return false;

  const stillUsed = store.instances.list.some((i) => i.versionId === versionId);
  if (stillUsed) return false;

  try {
    fs.rmSync(P.versionDir(versionId), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Применяет смену загрузчика.
 * Порядок шагов подобран так, чтобы точка невозврата была одна и в самом конце.
 */
async function apply({ instanceId, loader, loaderVersion, modsAction = 'backup' }, onProgress) {
  const report = onProgress || (() => {});
  const inst = store.getInstance(instanceId);
  if (!inst) throw new Error('Сборка не найдена');
  if (!LOADERS.includes(loader)) throw new Error('Неизвестный загрузчик: ' + loader);
  if (!MOD_ACTIONS.includes(modsAction)) throw new Error('Неизвестное действие с модами: ' + modsAction);

  const previousVersionId = inst.versionId;
  const previousLoader = inst.loader;

  // Шаг 1. Ставим профиль нового загрузчика в общую versions/.
  // Сборка всё ещё запускается на старом профиле — она не тронута.
  report({ stage: 'loader', label: 'Установка ' + loader, done: 0, total: 1 });
  const resolved = await instances.installLoader(loader, inst.mcVersion, loaderVersion, report, store.settings);

  // Шаг 2. Докачиваем файлы версии. Тоже только добавление.
  report({ stage: 'loader', label: 'Файлы версии ' + resolved.versionId, done: 0, total: 1 });
  await installVersion(resolved.versionId, report, store.settings);

  // Шаг 3. Моды. Переименование папки атомарно.
  const modsResult = handleMods(instanceId, modsAction, previousLoader);

  // Шаг 4. Точка невозврата: запись о сборке. store пишет во временный файл и делает rename.
  const updated = store.upsertInstance({
    ...inst,
    loader,
    loaderVersion: resolved.loaderVersion || loaderVersion || null,
    versionId: resolved.versionId,
  });

  // Шаг 5. Уборка — уже после успеха, и только если профиль никому не нужен
  const removedOld = previousVersionId !== resolved.versionId
    ? cleanupUnusedVersion(previousVersionId)
    : false;

  report({ stage: 'loader', label: 'Готово', done: 1, total: 1 });
  return {
    instance: updated,
    from: previousLoader,
    to: loader,
    versionId: resolved.versionId,
    mods: modsResult,
    removedOldProfile: removedOld,
  };
}

module.exports = { availableLoaders, plan, apply, cleanupUnusedVersion, countMods, LOADERS, MOD_ACTIONS };
