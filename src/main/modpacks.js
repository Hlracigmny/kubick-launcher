'use strict';
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const P = require('./paths');
const { downloadFile, downloadPool, request, readBody } = require('./net');
const instances = require('./instances');

const CURSEFORGE = 'https://api.curseforge.com/v1';

/* --------------------------- Общие помощники --------------------------- */

/** Ключи загрузчиков в манифестах отличаются от наших внутренних названий. */
const MODRINTH_LOADER = {
  'fabric-loader': 'fabric',
  'quilt-loader': 'quilt',
  forge: 'forge',
  neoforge: 'neoforge',
};

const CF_LOADER = {
  forge: 'forge',
  fabric: 'fabric',
  quilt: 'quilt',
  neoforge: 'neoforge',
};

function safeJoin(base, relative) {
  // Записи архива приходят извне: не даём им вырваться за пределы папки сборки
  const target = path.join(base, relative.split('/').join(path.sep));
  if (!path.resolve(target).startsWith(path.resolve(base) + path.sep)) {
    throw new Error('Модпак содержит недопустимый путь: ' + relative);
  }
  return target;
}

/** Копирует overrides из архива в папку сборки. */
function applyOverrides(zip, instanceDir, folders) {
  let copied = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    const folder = folders.find((f) => name.startsWith(f + '/'));
    if (!folder) continue;
    const relative = name.slice(folder.length + 1);
    if (!relative) continue;
    const dest = safeJoin(instanceDir, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    copied++;
  }
  return copied;
}

function openPack(file) {
  try {
    return new AdmZip(file);
  } catch {
    fs.rmSync(file, { force: true });
    throw new Error('Файл модпака повреждён — попробуйте установить ещё раз');
  }
}

/* ------------------------------ Modrinth ------------------------------ */

/**
 * .mrpack — обычный zip: modrinth.index.json со списком файлов и папка overrides.
 * Все ссылки ведут на официальные CDN, поэтому ключи API не нужны.
 */
function readModrinthIndex(zip) {
  const entry = zip.getEntry('modrinth.index.json');
  if (!entry) throw new Error('В .mrpack нет modrinth.index.json');
  const index = JSON.parse(entry.getData().toString('utf8'));

  const deps = index.dependencies || {};
  const mcVersion = deps.minecraft;
  if (!mcVersion) throw new Error('В модпаке не указана версия Minecraft');

  let loader = 'vanilla';
  let loaderVersion = null;
  for (const [key, value] of Object.entries(deps)) {
    if (key === 'minecraft') continue;
    if (MODRINTH_LOADER[key]) {
      loader = MODRINTH_LOADER[key];
      loaderVersion = value;
      break;
    }
  }

  const files = (index.files || [])
    .filter((f) => {
      // env.client === 'unsupported' — файл только для сервера
      const env = f.env || {};
      return env.client !== 'unsupported';
    })
    .map((f) => ({
      path: f.path,
      url: (f.downloads || [])[0],
      sha1: f.hashes && f.hashes.sha1,
      size: f.fileSize,
      optional: (f.env || {}).client === 'optional',
    }))
    .filter((f) => f.url && f.path);

  return { name: index.name, packVersion: index.versionId, mcVersion, loader, loaderVersion, files };
}

/* ----------------------------- CurseForge ----------------------------- */

async function cfPost(pathname, body, apiKey) {
  if (!apiKey) {
    const err = new Error('Для сборок CurseForge нужен API-ключ. Укажите его в Настройках → Интеграции.');
    err.code = 'NO_CF_KEY';
    throw err;
  }
  const payload = JSON.stringify(body);
  const { res, status } = await request(CURSEFORGE + pathname, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: payload,
  });
  const text = (await readBody(res)).toString('utf8');
  if (status >= 400) throw new Error('CurseForge вернул ошибку ' + status);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('CurseForge вернул некорректный ответ');
  }
}

function readCurseForgeManifest(zip) {
  const entry = zip.getEntry('manifest.json');
  if (!entry) throw new Error('В архиве сборки нет manifest.json');
  const manifest = JSON.parse(entry.getData().toString('utf8'));

  const mc = manifest.minecraft || {};
  const mcVersion = mc.version;
  if (!mcVersion) throw new Error('В сборке не указана версия Minecraft');

  let loader = 'vanilla';
  let loaderVersion = null;
  const loaders = mc.modLoaders || [];
  const primary = loaders.find((l) => l.primary) || loaders[0];
  if (primary && primary.id) {
    // id выглядит как "forge-47.2.0" или "neoforge-21.4.10"
    const dash = primary.id.indexOf('-');
    const kind = dash > 0 ? primary.id.slice(0, dash) : primary.id;
    loader = CF_LOADER[kind.toLowerCase()] || 'vanilla';
    loaderVersion = dash > 0 ? primary.id.slice(dash + 1) : null;
  }

  return {
    name: manifest.name,
    packVersion: manifest.version,
    mcVersion,
    loader,
    loaderVersion,
    fileRefs: (manifest.files || []).map((f) => ({ projectID: f.projectID, fileID: f.fileID, required: f.required !== false })),
    overridesDir: manifest.overrides || 'overrides',
  };
}

/** Разрешает пары projectID/fileID в прямые ссылки — пачками, а не по одной. */
async function resolveCurseForgeFiles(fileRefs, apiKey, report) {
  const ids = fileRefs.map((f) => f.fileID).filter(Boolean);
  const resolved = [];
  const CHUNK = 100;

  for (let i = 0; i < ids.length; i += CHUNK) {
    report({ stage: 'modpack', label: 'Определяем ссылки на моды', done: i, total: ids.length });
    const chunk = ids.slice(i, i + CHUNK);
    const data = await cfPost('/mods/files', { fileIds: chunk }, apiKey);
    for (const f of data.data || []) {
      const url = f.downloadUrl || cfFallbackUrl(f.id, f.fileName);
      if (!url) continue;
      const sha1entry = (f.hashes || []).find((h) => h.algo === 1);
      resolved.push({
        path: 'mods/' + f.fileName,
        url,
        sha1: sha1entry ? sha1entry.value : null,
        size: f.fileLength,
      });
    }
  }
  return resolved;
}

function cfFallbackUrl(fileId, fileName) {
  if (!fileId || !fileName) return null;
  const id = String(fileId);
  return 'https://edge.forgecdn.net/files/' + id.slice(0, 4) + '/' + Number(id.slice(4)) + '/' + fileName;
}

/* ------------------------------ Установка ----------------------------- */

/**
 * Ставит пользовательскую сборку целиком: скачивает архив, создаёт сборку
 * с нужной версией игры и загрузчиком, докачивает моды и раскладывает overrides.
 */
async function install({ source, version, name }, settings, onProgress) {
  const report = onProgress || (() => {});
  const opts = settings || {};

  if (!version || !version.file || !version.file.url) {
    throw new Error('У этой сборки нет файла для скачивания');
  }

  report({ stage: 'modpack', label: 'Загрузка сборки', done: 0, total: 1 });
  const packFile = path.join(P.cache, 'modpack-' + source + '-' + version.id + path.extname(version.file.filename || '.zip'));
  await downloadFile(version.file.url, packFile, {
    sha1: version.file.sha1,
    size: version.file.size,
    attempts: 3,
  });

  // Дальше файл на диске, и путь одинаков для скачанного и для выбранного вручную
  return installFromFile({
    file: packFile, name, source, removeAfter: true,
    origin: { projectId: version.projectId, versionId: version.id },
  }, settings, onProgress);
}

/** Что за пакет лежит в файле: .mrpack от Modrinth или zip от CurseForge. */
function detectPack(file) {
  const zip = openPack(file);
  if (zip.getEntry('modrinth.index.json')) return { zip, source: 'modrinth' };
  if (zip.getEntry('manifest.json')) return { zip, source: 'curseforge' };
  throw new Error('Это не модпак: внутри нет ни modrinth.index.json, ни manifest.json');
}

/** Краткое описание пакета без установки — чтобы показать до того, как ставить. */
function inspectFile(file) {
  const { zip, source } = detectPack(file);
  const info = source === 'modrinth' ? readModrinthIndex(zip) : readCurseForgeManifest(zip);
  const overrides = zip.getEntries()
    .filter((e) => !e.isDirectory && /^(overrides|client-overrides)\//.test(e.entryName));
  return {
    source,
    name: info.name,
    mcVersion: info.mcVersion,
    loader: info.loader,
    loaderVersion: info.loaderVersion,
    packVersion: info.packVersion || null,
    modCount: source === 'modrinth' ? (info.files || []).length : (info.fileRefs || []).length,
    overrideFiles: overrides.length,
    size: (() => { try { return fs.statSync(file).size; } catch { return 0; } })(),
  };
}

/**
 * Ставит модпак из файла на диске. Отдельно от install(), потому что файл может
 * быть и скачанным из каталога, и выбранным пользователем вручную —
 * дальше разницы никакой.
 */
async function installFromFile({ file, name, source, removeAfter = false, origin = null }, settings, onProgress) {
  const report = onProgress || (() => {});
  const opts = settings || {};

  const detected = detectPack(file);
  const zip = detected.zip;
  const packFile = file;
  source = source || detected.source;
  const isModrinth = source === 'modrinth';
  const info = isModrinth ? readModrinthIndex(zip) : readCurseForgeManifest(zip);

  report({ stage: 'modpack', label: 'Установка ' + info.loader + ' ' + info.mcVersion, done: 0, total: 1 });

  const instance = await instances.create({
    name: name || info.name || 'Сборка',
    mcVersion: info.mcVersion,
    loader: info.loader,
    loaderVersion: info.loaderVersion,
  }, report);

  const instanceDir = P.instanceDir(instance.id);

  // Список файлов: у Modrinth он прямо в индексе, у CurseForge его надо разрешить через API
  let files = [];
  try {
    files = isModrinth
      ? info.files
      : await resolveCurseForgeFiles(info.fileRefs, opts.curseforgeKey, report);
  } catch (e) {
    // Сборка уже создана — не бросаем пользователя с пустой папкой без объяснений
    instances.remove(instance.id, true);
    throw e;
  }

  let done = 0;
  report({ stage: 'modpack', label: 'Загрузка модов сборки', done: 0, total: files.length });
  await downloadPool(files, opts.maxDownloads || 10, async (f) => {
    const dest = safeJoin(instanceDir, f.path);
    try {
      await downloadFile(f.url, dest, { sha1: f.sha1, size: f.size, attempts: 3 });
    } catch (e) {
      // Необязательные файлы не должны рушить установку всей сборки
      if (!f.optional) throw e;
    } finally {
      done++;
      if (done % 5 === 0 || done === files.length) {
        report({ stage: 'modpack', label: 'Загрузка модов сборки', done, total: files.length });
      }
    }
  });

  report({ stage: 'modpack', label: 'Копирование настроек сборки', done: 0, total: 1 });
  const overrideFolders = isModrinth
    ? ['overrides', 'client-overrides']
    : [info.overridesDir, 'overrides'];
  const copied = applyOverrides(zip, instanceDir, [...new Set(overrideFolders)]);

  // Запоминаем происхождение — пригодится для обновления сборки в будущем.
  // У файла, выбранного вручную, происхождения нет: обновлять его неоткуда.
  const { store } = require('./store');
  const current = store.getInstance(instance.id);
  if (current) {
    store.upsertInstance({
      ...current,
      modpack: {
        source,
        projectId: origin ? origin.projectId : null,
        versionId: origin ? origin.versionId : null,
        packVersion: info.packVersion || null,
        fromFile: !origin,
        installedAt: Date.now(),
      },
    });
  }

  // Скачанный в кеш пакет убираем, а выбранный пользователем файл — его собственный
  if (removeAfter) fs.rmSync(packFile, { force: true });
  report({ stage: 'modpack', label: 'Сборка готова', done: 1, total: 1 });

  return {
    instance: store.getInstance(instance.id) || instance,
    modCount: files.length,
    overrideFiles: copied,
    mcVersion: info.mcVersion,
    loader: info.loader,
  };
}

module.exports = {
  install, installFromFile, inspectFile, detectPack,
  readModrinthIndex, readCurseForgeManifest,
};
