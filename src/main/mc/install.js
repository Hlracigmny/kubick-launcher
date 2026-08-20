'use strict';
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const P = require('../paths');
const { downloadFile, downloadPool } = require('../net');
const { ensureVanillaJson } = require('./manifest');
const R = require('./rules');

const DEFAULT_LIB_REPO = 'https://libraries.minecraft.net/';
const RESOURCES = 'https://resources.download.minecraft.net/';

function readLocalJson(id) {
  const file = P.versionJson(id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Повреждён файл версии ' + id + '.json — удалите папку versions/' + id + ' и переустановите');
  }
}

/** Загружает version.json и рекурсивно разворачивает inheritsFrom (Fabric/Forge поверх ванили). */
async function resolveVersion(id, seen = new Set()) {
  if (seen.has(id)) throw new Error('Циклическое наследование версий: ' + id);
  seen.add(id);

  let json = readLocalJson(id);
  if (!json) json = await ensureVanillaJson(id);
  if (!json.inheritsFrom) return json;

  const parent = await resolveVersion(json.inheritsFrom, seen);
  const merged = R.mergeVersions(parent, json);
  merged.id = json.id;
  return merged;
}

function isNativeLib(lib) {
  if (lib.natives) return true;
  const classifier = String(lib.name || '').split(':')[3] || '';
  return classifier.startsWith('natives');
}

/** Разбирает библиотеку в дескриптор загрузки: локальный путь + откуда качать. */
function describeLibrary(lib) {
  const native = isNativeLib(lib);
  let art = null;

  if (lib.downloads) {
    if (lib.natives) {
      const cls = R.nativeClassifier(lib);
      art = cls && lib.downloads.classifiers ? lib.downloads.classifiers[cls] : null;
      if (!art) return null; // натива под эту ОС нет — это нормально
    } else {
      art = lib.downloads.artifact || null;
    }
  }

  const relative = (art && art.path) ? art.path.split('/').join(path.sep) : R.mavenToPath(lib.name);
  const dest = path.join(P.libraries, relative);
  const url = (art && art.url) || R.mavenToUrl(lib.url || DEFAULT_LIB_REPO, lib.name);

  return {
    name: lib.name,
    dest,
    url,
    sha1: art && art.sha1,
    size: art && art.size,
    native,
    extract: lib.extract || null,
    optional: !art && !lib.url,
  };
}

/** Собирает classpath, список нативов и очередь загрузок для версии. */
function collectLibraries(version, features = {}) {
  const libs = R.dedupeLibraries(version.libraries || []);
  const classpath = [];
  const natives = [];
  const downloads = [];

  for (const lib of libs) {
    if (!R.rulesAllow(lib.rules, features)) continue;
    // Правила Mojang не различают архитектуру нативов — отбираем её по классификатору
    if (!R.nativeFitsHost(lib.name)) continue;
    const d = describeLibrary(lib);
    if (!d) continue;
    downloads.push(d);
    // Нативная библиотека нужна в обоих местах сразу.
    // Старые версии запускаются от распакованных .dll рядом в папке нативов,
    // а начиная с 1.19 Mojang отдаёт натив обычным jar и распаковывает его сама —
    // LWJGL ищет его в classpath и кладёт в org.lwjgl.system.SharedLibraryExtractPath.
    // Если натив не положить в classpath, свежие версии падают на старте:
    // UnsatisfiedLinkError: Failed to locate library: lwjgl.dll
    if (d.native) natives.push(d);
    classpath.push(d.dest);

    // Старый формат: одна библиотека даёт и обычный jar, и отдельный натив
    if (lib.natives && lib.downloads && lib.downloads.artifact) {
      const main = {
        name: lib.name,
        dest: path.join(P.libraries, lib.downloads.artifact.path.split('/').join(path.sep)),
        url: lib.downloads.artifact.url,
        sha1: lib.downloads.artifact.sha1,
        size: lib.downloads.artifact.size,
        native: false,
      };
      downloads.push(main);
      classpath.push(main.dest);
    }
  }
  // В манифестах 1.13–1.18 jar с классами перечислен и сам по себе, и рядом с нативом,
  // поэтому один и тот же путь попадает в список дважды. Повторы в classpath
  // безобидными не бывают: у Forge они ломают запуск, поэтому чистим здесь.
  return {
    classpath: uniqueBy(classpath, (p) => p),
    natives: uniqueBy(natives, (n) => n.dest),
    downloads: uniqueBy(downloads, (d) => d.dest),
  };
}

function uniqueBy(list, keyOf) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// Архивы LWJGL кроме самих библиотек содержат .sha1/.git — в папку нативов они не нужны
const NATIVE_BINARY = /\.(dll|so|dylib|jnilib)$/i;

function extractNatives(nativeDescriptors, targetDir) {
  // Чистим папку, чтобы натив от прежней версии или другой архитектуры не остался лежать рядом
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
  } catch {
    // папку держит запущенная игра — тогда просто перезапишем файлы поверх
  }
  fs.mkdirSync(targetDir, { recursive: true });
  for (const nat of nativeDescriptors) {
    if (!fs.existsSync(nat.dest)) continue;
    let zip;
    try {
      zip = new AdmZip(nat.dest);
    } catch {
      continue;
    }
    const exclude = (nat.extract && nat.extract.exclude) || [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName;
      if (name.startsWith('META-INF/')) continue;
      if (!NATIVE_BINARY.test(name)) continue;
      if (exclude.some((ex) => name.startsWith(ex))) continue;
      // basename защищает от path traversal внутри архива
      const out = path.join(targetDir, path.basename(name));
      try {
        fs.writeFileSync(out, entry.getData());
      } catch {
        // файл уже занят запущенной игрой — он и так актуален
      }
    }
  }
}

/**
 * Начиная с 1.19 ${natives_directory} — не папка с .dll, а корень рабочих подпапок:
 * java (java.library.path), jna, lwjgl (куда LWJGL распаковывает себя), netty.
 * Их надо создать заранее — иначе игра пишет в отчёте о падении
 * «Contents of java.library.path : <not a directory>» и не стартует.
 */
const NATIVE_SCRATCH_DIRS = ['java', 'jna', 'lwjgl', 'netty'];

function prepareNativeScratchDirs(nativesDir) {
  for (const sub of NATIVE_SCRATCH_DIRS) {
    try { fs.mkdirSync(path.join(nativesDir, sub), { recursive: true }); }
    catch { /* папку держит запущенная игра — она уже есть */ }
  }
}

async function installAssets(version, report, maxDownloads) {
  const index = version.assetIndex;
  if (!index) return;
  const indexFile = path.join(P.assetIndexes, index.id + '.json');
  await downloadFile(index.url, indexFile, { sha1: index.sha1, size: index.size });
  const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const objects = Object.entries(data.objects || {});

  let done = 0;
  report({ stage: 'assets', label: 'Ресурсы игры', done: 0, total: objects.length });
  await downloadPool(objects, maxDownloads, async (pair) => {
    const name = pair[0];
    const obj = pair[1];
    const sub = obj.hash.slice(0, 2);
    const dest = path.join(P.assetObjects, sub, obj.hash);
    await downloadFile(RESOURCES + sub + '/' + obj.hash, dest, { sha1: obj.hash, size: obj.size });

    // Версии до 1.7 читают ресурсы из обычной папки, а не из хеш-хранилища
    if (data.virtual || data.map_to_resources) {
      const legacyRoot = data.map_to_resources
        ? path.join(P.root, 'resources')
        : path.join(P.assets, 'virtual', 'legacy');
      const target = path.join(legacyRoot, name.split('/').join(path.sep));
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(dest, target);
      }
    }
    done++;
    if (done % 25 === 0 || done === objects.length) {
      report({ stage: 'assets', label: 'Ресурсы игры', done, total: objects.length });
    }
  });
}

/**
 * Полная установка версии: json -> client.jar -> библиотеки -> нативы -> ассеты.
 * Идемпотентна: валидные файлы пропускаются, поэтому повторный запуск дешёвый.
 */
async function installVersion(id, onProgress, settings) {
  const opts = settings || {};
  const report = (p) => {
    try { (onProgress || (() => {}))(p); } catch { /* окно могли закрыть */ }
  };
  const maxDownloads = opts.maxDownloads || 12;

  report({ stage: 'meta', label: 'Чтение метаданных версии', done: 0, total: 1 });
  const version = await resolveVersion(id);

  const jarPath = P.versionJar(version.id);
  const clientDl = version.downloads && version.downloads.client;
  if (clientDl) {
    report({ stage: 'client', label: 'Клиент Minecraft', done: 0, total: 1 });
    await downloadFile(clientDl.url, jarPath, { sha1: clientDl.sha1, size: clientDl.size });
    report({ stage: 'client', label: 'Клиент Minecraft', done: 1, total: 1 });
  } else if (!fs.existsSync(jarPath)) {
    const base = version.inheritsFrom || version.jar;
    if (base && fs.existsSync(P.versionJar(base))) fs.copyFileSync(P.versionJar(base), jarPath);
  }

  const collected = collectLibraries(version);
  const downloads = collected.downloads;
  let libDone = 0;
  report({ stage: 'libraries', label: 'Библиотеки', done: 0, total: downloads.length });
  await downloadPool(downloads, maxDownloads, async (d) => {
    try {
      await downloadFile(d.url, d.dest, { sha1: d.sha1, size: d.size });
    } catch (e) {
      // Файл, положенный установщиком Forge, важнее сети
      if (fs.existsSync(d.dest) || d.optional) return;
      throw e;
    } finally {
      libDone++;
      if (libDone % 5 === 0 || libDone === downloads.length) {
        report({ stage: 'libraries', label: 'Библиотеки', done: libDone, total: downloads.length });
      }
    }
  });

  const nativesDir = path.join(P.natives, version.id);
  report({ stage: 'natives', label: 'Нативные библиотеки', done: 0, total: 1 });
  extractNatives(collected.natives, nativesDir);
  prepareNativeScratchDirs(nativesDir);
  report({ stage: 'natives', label: 'Нативные библиотеки', done: 1, total: 1 });

  if (version.logging && version.logging.client && version.logging.client.file) {
    const lf = version.logging.client.file;
    const dest = path.join(P.assets, 'log_configs', lf.id);
    try {
      await downloadFile(lf.url, dest, { sha1: lf.sha1, size: lf.size });
    } catch {
      // конфиг логирования необязателен
    }
  }

  await installAssets(version, report, maxDownloads);

  report({ stage: 'done', label: 'Готово', done: 1, total: 1 });
  return { version, classpath: collected.classpath, nativesDir, jarPath };
}

module.exports = { resolveVersion, collectLibraries, installVersion, extractNatives, isNativeLib };
