'use strict';
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const P = require('./paths');
const { store } = require('./store');
const instances = require('./instances');
const modpacks = require('./modpacks');

/**
 * Перенос сборок между машинами одним файлом.
 *
 * Формат `.kubick` — обычный zip:
 *   kubick.json      описание сборки (версия игры, загрузчик, что вложено)
 *   overrides/…      содержимое папки сборки: mods, config, resourcepacks и прочее
 *
 * Файлы самой игры внутрь не кладутся: они одинаковы у всех и весят сотни мегабайт.
 * При импорте нужная версия и загрузчик ставятся заново, а из архива приезжает
 * только то, что делает сборку этой сборкой.
 */
const FORMAT = 1;
const MANIFEST = 'kubick.json';

/** Что можно положить в архив. Порядок задаёт и порядок галочек в интерфейсе. */
const PARTS = [
  { id: 'mods', label: 'Моды', paths: ['mods'] },
  { id: 'config', label: 'Конфиги модов', paths: ['config', 'defaultconfigs'] },
  { id: 'resourcepacks', label: 'Наборы ресурсов', paths: ['resourcepacks'] },
  { id: 'shaderpacks', label: 'Наборы шейдеров', paths: ['shaderpacks'] },
  { id: 'options', label: 'Настройки игры', paths: ['options.txt', 'optionsof.txt', 'servers.dat'] },
  { id: 'saves', label: 'Миры', paths: ['saves'] },
];

function partsFor(selected) {
  const wanted = new Set(selected && selected.length ? selected : PARTS.map((p) => p.id));
  return PARTS.filter((p) => wanted.has(p.id));
}

/** Размер того, что попадёт в архив — чтобы предупредить о мирах на пару гигабайт. */
function sizeOf(target) {
  let total = 0;
  let stat;
  try { stat = fs.statSync(target); } catch { return 0; }
  if (stat.isFile()) return stat.size;
  let entries = [];
  try { entries = fs.readdirSync(target); } catch { return 0; }
  for (const name of entries) total += sizeOf(path.join(target, name));
  return total;
}

/** Сводка по сборке для окна экспорта: что есть на диске и сколько весит. */
function inspect(id) {
  const inst = store.getInstance(id);
  if (!inst) throw new Error('Сборка не найдена');
  const dir = P.instanceDir(id);

  return {
    instance: { id: inst.id, name: inst.name, mcVersion: inst.mcVersion, loader: inst.loader },
    parts: PARTS.map((part) => {
      const size = part.paths.reduce((sum, rel) => sum + sizeOf(path.join(dir, rel)), 0);
      return { id: part.id, label: part.label, size, present: size > 0 };
    }),
  };
}

/* ------------------------------- Экспорт -------------------------------- */

/**
 * Собирает `.kubick` из сборки. Возвращает путь к файлу и что в него попало.
 */
function exportInstance({ id, file, parts, includeSettings = true }) {
  const inst = store.getInstance(id);
  if (!inst) throw new Error('Сборка не найдена');
  const dir = P.instanceDir(id);
  if (!fs.existsSync(dir)) throw new Error('Папка сборки не найдена — возможно, её удалили вручную');

  const chosen = partsFor(parts);
  const zip = new AdmZip();
  const included = [];

  for (const part of chosen) {
    let any = false;
    for (const rel of part.paths) {
      const source = path.join(dir, rel);
      let stat;
      try { stat = fs.statSync(source); } catch { continue; }
      if (stat.isDirectory()) {
        // Отключённые моды переносим как есть: пусть на новой машине они тоже будут выключены
        zip.addLocalFolder(source, 'overrides/' + rel);
      } else {
        zip.addLocalFile(source, 'overrides/' + path.dirname(rel).replace(/^\.$/, ''));
      }
      any = true;
    }
    if (any) included.push(part.id);
  }

  const manifest = {
    format: FORMAT,
    exportedAt: Date.now(),
    name: inst.name,
    mcVersion: inst.mcVersion,
    loader: inst.loader,
    loaderVersion: inst.loaderVersion || null,
    versionId: inst.versionId,
    icon: inst.icon || null,
    // Личные настройки запуска переносим по желанию: путь к Java с чужой машины бесполезен
    overrides: includeSettings ? sanitizeOverrides(inst.overrides) : {},
    included,
  };
  zip.addFile(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  fs.mkdirSync(path.dirname(file), { recursive: true });
  zip.writeZip(file);

  return { file, size: sizeOf(file), included, name: inst.name };
}

/** Имя файла по умолчанию: без символов, запрещённых в путях Windows. */
function suggestedFileName(id) {
  const inst = store.getInstance(id);
  const base = String((inst && inst.name) || 'instance')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (base || 'instance') + '.kubick';
}

/** Из переопределений сборки берём только то, что осмысленно на другой машине. */
function sanitizeOverrides(overrides) {
  const src = overrides || {};
  const out = {};
  for (const key of ['memoryMb', 'jvmArgs', 'width', 'height', 'fullscreen']) {
    if (src[key] != null) out[key] = src[key];
  }
  return out;
}

/* -------------------------------- Импорт -------------------------------- */

function readManifest(file) {
  let zip;
  try { zip = new AdmZip(file); } catch { throw new Error('Файл не открывается как архив'); }

  const entry = zip.getEntry(MANIFEST);
  if (!entry) {
    throw new Error('Это не сборка Kubick: внутри нет ' + MANIFEST +
      '. Готовые сборки формата .mrpack ставятся через каталог модпаков.');
  }

  let data;
  try { data = JSON.parse(zip.readAsText(entry)); } catch { throw new Error('Описание сборки повреждено'); }
  if (!data.mcVersion) throw new Error('В описании сборки не указана версия Minecraft');
  if (Number(data.format) > FORMAT) {
    throw new Error('Файл сделан более новой версией лаунчера — обновите Kubick Launcher');
  }
  return { zip, data };
}

/**
 * Определяет, что за файл выбрали. Кроме своего .kubick лаунчер принимает
 * готовые сборки в архивах: .mrpack от Modrinth и zip от CurseForge —
 * это то, что игроки чаще всего и скачивают.
 */
function detectFormat(file) {
  let zip;
  try { zip = new AdmZip(file); } catch { throw new Error('Файл не открывается как архив'); }

  if (zip.getEntry(MANIFEST)) return 'kubick';
  if (zip.getEntry('modrinth.index.json')) return 'mrpack';
  if (zip.getEntry('manifest.json')) return 'curseforge';

  throw new Error('Не удалось понять, что это за файл. Подойдёт сборка Kubick (.kubick), ' +
    'сборка Modrinth (.mrpack) или архив сборки CurseForge (.zip).');
}

/** Что внутри файла — показывается до установки, чтобы не ставить вслепую. */
function preview(file) {
  const format = detectFormat(file);
  if (format !== 'kubick') {
    const info = modpacks.inspectFile(file);
    return {
      format,
      name: info.name || 'Готовая сборка',
      mcVersion: info.mcVersion,
      loader: info.loader,
      loaderVersion: info.loaderVersion,
      packVersion: info.packVersion,
      exportedAt: null,
      size: info.size,
      // У модпака состав другой: моды докачиваются, а не лежат внутри
      folders: [
        { folder: 'моды из каталога', files: info.modCount },
        { folder: 'файлы настроек', files: info.overrideFiles },
      ].filter((f) => f.files > 0),
      needsCurseforgeKey: format === 'curseforge',
    };
  }

  const { zip, data } = readManifest(file);
  const counts = {};
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.startsWith('overrides/')) continue;
    const top = entry.entryName.slice('overrides/'.length).split('/')[0];
    if (!top) continue;
    counts[top] = (counts[top] || 0) + 1;
  }
  return {
    format: 'kubick',
    name: data.name || 'Сборка',
    mcVersion: data.mcVersion,
    loader: data.loader || 'vanilla',
    loaderVersion: data.loaderVersion || null,
    exportedAt: data.exportedAt || null,
    folders: Object.entries(counts).map(([folder, files]) => ({ folder, files }))
      .sort((a, b) => b.files - a.files),
    size: sizeOf(file),
  };
}

/** Защита от путей вида ../../: распаковываем строго внутрь папки сборки. */
function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('Архив содержит недопустимый путь: ' + relative);
  }
  return target;
}

/**
 * Ставит сборку из файла: создаёт её заново (со скачиванием версии и загрузчика),
 * затем раскладывает содержимое overrides.
 */
async function importInstance({ file, name }, onProgress, settings) {
  const report = onProgress || (() => {});

  // Готовую сборку из архива ставит modpacks: там уже есть и разбор манифеста,
  // и докачка модов по ссылкам, и раскладка overrides
  const format = detectFormat(file);
  if (format !== 'kubick') {
    const res = await modpacks.installFromFile({ file, name, removeAfter: false }, settings, report);
    return { instance: res.instance, files: res.modCount + res.overrideFiles, format };
  }

  const { zip, data } = readManifest(file);

  report({ stage: 'import', label: 'Установка ' + (data.loader || 'vanilla') + ' ' + data.mcVersion, done: 0, total: 1 });

  const instance = await instances.create({
    name: name || data.name || 'Сборка',
    mcVersion: data.mcVersion,
    loader: data.loader || 'vanilla',
    loaderVersion: data.loaderVersion || null,
    icon: data.icon || null,
  }, report);

  const dir = P.instanceDir(instance.id);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && e.entryName.startsWith('overrides/'));

  report({ stage: 'import', label: 'Распаковка файлов сборки', done: 0, total: entries.length });
  let done = 0;
  try {
    for (const entry of entries) {
      const relative = entry.entryName.slice('overrides/'.length);
      if (!relative) continue;
      const target = safeJoin(dir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
      done++;
      if (done % 25 === 0 || done === entries.length) {
        report({ stage: 'import', label: 'Распаковка файлов сборки', done, total: entries.length });
      }
    }
  } catch (e) {
    // Сборка уже создана — не оставляем половину распакованного файла
    instances.remove(instance.id, true);
    throw e;
  }

  if (data.overrides && Object.keys(data.overrides).length) {
    store.upsertInstance({ ...store.getInstance(instance.id), overrides: sanitizeOverrides(data.overrides) });
  }

  report({ stage: 'import', label: 'Сборка готова', done: 1, total: 1 });
  return { instance: store.getInstance(instance.id) || instance, files: done };
}

module.exports = { inspect, exportInstance, preview, importInstance, detectFormat, suggestedFileName, PARTS };
