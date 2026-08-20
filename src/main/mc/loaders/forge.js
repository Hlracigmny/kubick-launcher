'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');
const P = require('../../paths');
const { fetchBuffer, downloadFile, downloadPool, sha1File } = require('../../net');
const R = require('../rules');
const { installVersion, resolveVersion } = require('../install');
const javaMod = require('../../java');

const FORGE_MAVEN = 'https://maven.minecraftforge.net';
const NEO_MAVEN = 'https://maven.neoforged.net/releases';
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';

function parseMavenMetadata(xml) {
  const out = [];
  const re = /<version>([^<]+)<\/version>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/**
 * NeoForge кодирует версию игры в своей, и схем две:
 *   старая — 21.4.10 для MC 1.21.4, 21.0.5 для MC 1.21;
 *   новая  — 26.2.0.55 для MC 26.2, 26.1.2.95 для MC 26.1.2.
 * Сопоставляем не разбором версии загрузчика, а префиксом от версии игры — так надёжнее.
 */
function neoPrefix(mcVersion) {
  const parts = String(mcVersion).split('.');
  if (parts[0] === '1') {
    const major = parts[1];
    const minor = parts[2] || '0';
    if (!major) return null;
    return major + '.' + minor + '.';
  }
  if (parts.length === 2) return parts[0] + '.' + parts[1] + '.0.';
  return parts.join('.') + '.';
}

/** Обратное преобразование — используется только для подсказок в интерфейсе. */
function neoToMc(version) {
  const parts = String(version).split('.');
  if (parts.length >= 4) {
    const trimmed = parts[2] === '0' ? parts.slice(0, 2) : parts.slice(0, 3);
    return trimmed.join('.');
  }
  const major = parts[0];
  const minor = parts[1];
  if (!major || minor === undefined) return null;
  return minor === '0' ? '1.' + major : '1.' + major + '.' + minor;
}

async function listForge(mcVersion) {
  const xml = (await fetchBuffer(FORGE_MAVEN + '/net/minecraftforge/forge/maven-metadata.xml')).toString('utf8');
  const all = parseMavenMetadata(xml);
  const prefix = mcVersion + '-';
  const versions = all.filter((v) => v.startsWith(prefix)).map((v) => v.slice(prefix.length));

  let recommended = null;
  let latest = null;
  try {
    const promos = await require('../../net').fetchJson(FORGE_PROMOS);
    const p = promos.promos || {};
    recommended = p[mcVersion + '-recommended'] || null;
    latest = p[mcVersion + '-latest'] || null;
  } catch {
    // промо-файл иногда недоступен, список версий всё равно рабочий
  }

  return versions.reverse().map((v) => ({
    version: v,
    full: mcVersion + '-' + v,
    recommended: v === recommended,
    latest: v === latest,
  }));
}

async function listNeoForge(mcVersion) {
  const result = [];

  // Для 1.20.1 NeoForge жил в артефакте net.neoforged:forge
  if (mcVersion === '1.20.1') {
    try {
      const xml = (await fetchBuffer(NEO_MAVEN + '/net/neoforged/forge/maven-metadata.xml')).toString('utf8');
      for (const v of parseMavenMetadata(xml)) {
        if (v.startsWith('1.20.1-')) result.push({ version: v, full: v, legacy: true });
      }
    } catch {
      // артефакт может отсутствовать
    }
    return result.reverse();
  }

  const prefix = neoPrefix(mcVersion);
  if (!prefix) return result;
  const xml = (await fetchBuffer(NEO_MAVEN + '/net/neoforged/neoforge/maven-metadata.xml')).toString('utf8');
  for (const v of parseMavenMetadata(xml)) {
    if (v.startsWith(prefix)) result.push({ version: v, full: v, beta: v.includes('beta') });
  }
  // maven-metadata отдаёт версии не по порядку, поэтому сортируем сами
  result.sort((a, b) => R.compareVersions(b.version, a.version));
  if (result.length) result[0].latest = true;
  const stable = result.find((e) => !e.beta);
  if (stable) stable.recommended = true;
  return result;
}

function installerUrl(kind, mcVersion, loaderVersion, legacy) {
  if (kind === 'forge') {
    const full = mcVersion + '-' + loaderVersion;
    return FORGE_MAVEN + '/net/minecraftforge/forge/' + full + '/forge-' + full + '-installer.jar';
  }
  if (legacy || loaderVersion.startsWith('1.20.1-')) {
    return NEO_MAVEN + '/net/neoforged/forge/' + loaderVersion + '/forge-' + loaderVersion + '-installer.jar';
  }
  return NEO_MAVEN + '/net/neoforged/neoforge/' + loaderVersion + '/neoforge-' + loaderVersion + '-installer.jar';
}

function readMainClass(jarPath) {
  try {
    const zip = new AdmZip(jarPath);
    const entry = zip.getEntry('META-INF/MANIFEST.MF');
    if (!entry) return null;
    const text = entry.getData().toString('utf8');
    const m = /Main-Class:\s*(\S+)/.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function libPath(mavenName) {
  return path.join(P.libraries, R.mavenToPath(mavenName));
}

/** Значения из install_profile.data бывают трёх видов: файл в архиве, maven-координата, литерал. */
function resolveDataValue(value, zip, workDir) {
  if (typeof value !== 'string' || !value) return value;
  if (value.startsWith('[') && value.endsWith(']')) return libPath(value.slice(1, -1));
  if (value.startsWith('/')) {
    const entryName = value.slice(1);
    const entry = zip.getEntry(entryName);
    if (!entry) return value;
    const out = path.join(workDir, entryName.split('/').join(path.sep));
    // Имя записи приходит из скачанного архива — не даём ей вырваться за пределы рабочей папки
    if (!path.resolve(out).startsWith(path.resolve(workDir) + path.sep)) {
      throw new Error('Установщик содержит недопустимый путь: ' + entryName);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, entry.getData());
    return out;
  }
  return value;
}

function resolveArg(arg, data) {
  if (typeof arg !== 'string') return String(arg);
  if (arg.startsWith('[') && arg.endsWith(']')) return libPath(arg.slice(1, -1));
  if (arg.startsWith('{') && arg.endsWith('}')) {
    const key = arg.slice(1, -1);
    return key in data ? data[key] : arg;
  }
  return arg.replace(/\{([A-Z_0-9]+)\}/g, (m, key) => (key in data ? data[key] : m));
}

function runJava(javaBin, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(javaBin, args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const tail = (String(stdout || '') + String(stderr || '')).split('\n').slice(-12).join('\n');
        reject(new Error('Процессор установщика завершился с ошибкой:\n' + tail));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

async function downloadProfileLibraries(libs, report, label, maxDownloads) {
  const items = (libs || []).filter((l) => l && l.name);
  let done = 0;
  report({ stage: 'loader', label, done: 0, total: items.length });
  await downloadPool(items, maxDownloads || 10, async (lib) => {
    const art = lib.downloads && lib.downloads.artifact;
    const dest = art && art.path ? path.join(P.libraries, art.path.split('/').join(path.sep)) : libPath(lib.name);
    const url = (art && art.url) || (lib.url ? R.mavenToUrl(lib.url, lib.name) : null);
    try {
      // Пустой url встречается у артефактов, которые генерируют сами процессоры
      if (url) await downloadFile(url, dest, { sha1: art && art.sha1, size: art && art.size });
    } catch (e) {
      if (!fs.existsSync(dest)) throw e;
    } finally {
      done++;
      if (done % 4 === 0 || done === items.length) report({ stage: 'loader', label, done, total: items.length });
    }
  });
}

/** Установщики до 1.13 просто кладут universal-jar и готовый versionInfo. */
async function installLegacyProfile(zip, profile, mcVersion, report) {
  const info = profile.install || {};
  const versionInfo = profile.versionInfo;
  if (!versionInfo || !versionInfo.id) throw new Error('Установщик Forge не содержит versionInfo');

  if (info.path) {
    const dest = libPath(info.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let entry = info.filePath ? zip.getEntry(info.filePath) : null;
    if (!entry) {
      const wanted = path.basename(R.mavenToPath(info.path));
      entry = zip.getEntries().find((e) => !e.isDirectory && path.basename(e.entryName) === wanted) || null;
    }
    if (entry) fs.writeFileSync(dest, entry.getData());
  }

  if (!versionInfo.inheritsFrom) versionInfo.inheritsFrom = info.minecraft || mcVersion;
  // В старых профилях у библиотек нет downloads — оставляем url для maven-резолва
  fs.mkdirSync(P.versionDir(versionInfo.id), { recursive: true });
  fs.writeFileSync(P.versionJson(versionInfo.id), JSON.stringify(versionInfo, null, 2), 'utf8');
  report({ stage: 'loader', label: 'Forge установлен', done: 1, total: 1 });
  return { versionId: versionInfo.id };
}

/**
 * Устанавливает Forge/NeoForge из официального установщика:
 * распаковывает профиль, докачивает библиотеки и выполняет процессоры
 * (деобфускация и патчинг клиента) той же Java, что запустит игру.
 */
async function install(kind, mcVersion, loaderVersion, onProgress, settings) {
  const report = onProgress || (() => {});
  const opts = settings || {};
  const legacyNeo = kind === 'neoforge' && mcVersion === '1.20.1';

  report({ stage: 'loader', label: 'Загрузка установщика ' + kind, done: 0, total: 1 });
  const url = installerUrl(kind, mcVersion, loaderVersion, legacyNeo);
  const installerPath = path.join(P.cache, kind + '-' + loaderVersion + '-installer.jar');
  await downloadFile(url, installerPath, { attempts: 3 });

  let zip;
  try {
    zip = new AdmZip(installerPath);
  } catch {
    fs.rmSync(installerPath, { force: true });
    throw new Error('Установщик ' + kind + ' повреждён, попробуйте ещё раз');
  }

  const profileEntry = zip.getEntry('install_profile.json');
  if (!profileEntry) throw new Error('В установщике нет install_profile.json');
  const profile = JSON.parse(profileEntry.getData().toString('utf8'));

  if (profile.install && profile.versionInfo) {
    return installLegacyProfile(zip, profile, mcVersion, report);
  }

  // Современный формат: отдельный version.json внутри архива
  const jsonPath = (profile.json || '/version.json').replace(/^\//, '');
  const versionEntry = zip.getEntry(jsonPath);
  if (!versionEntry) throw new Error('В установщике нет ' + jsonPath);
  const versionJson = JSON.parse(versionEntry.getData().toString('utf8'));
  if (!versionJson.inheritsFrom) versionJson.inheritsFrom = mcVersion;

  fs.mkdirSync(P.versionDir(versionJson.id), { recursive: true });
  fs.writeFileSync(P.versionJson(versionJson.id), JSON.stringify(versionJson, null, 2), 'utf8');

  // Процессорам нужен готовый ванильный клиент и его библиотеки
  report({ stage: 'loader', label: 'Подготовка базовой версии', done: 0, total: 1 });
  await installVersion(mcVersion, report, opts);

  await downloadProfileLibraries(profile.libraries, report, 'Библиотеки установщика', opts.maxDownloads);
  await downloadProfileLibraries(versionJson.libraries, report, 'Библиотеки ' + kind, opts.maxDownloads);

  const workDir = path.join(P.cache, kind + '-' + loaderVersion + '-work');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const data = {};
  for (const [key, entry] of Object.entries(profile.data || {})) {
    const raw = entry && typeof entry === 'object' ? entry.client : entry;
    data[key] = resolveDataValue(raw, zip, workDir);
  }
  data.SIDE = 'client';
  data.MINECRAFT_JAR = P.versionJar(mcVersion);
  data.MINECRAFT_VERSION = mcVersion;
  data.ROOT = P.root;
  data.INSTALLER = installerPath;
  data.LIBRARY_DIR = P.libraries;

  const resolved = await resolveVersion(versionJson.id);
  const javaInfo = await javaMod.resolveJava(resolved, opts, report);

  const processors = (profile.processors || []).filter(
    (p) => !p.sides || p.sides.includes('client')
  );

  for (let i = 0; i < processors.length; i++) {
    const proc = processors[i];
    report({ stage: 'loader', label: 'Патчинг клиента', done: i, total: processors.length });

    const outputs = {};
    for (const [k, v] of Object.entries(proc.outputs || {})) {
      outputs[resolveArg(k, data)] = resolveArg(v, data);
    }
    // Уже посчитанные выходы пропускаем — повторная установка становится почти мгновенной
    let upToDate = Object.keys(outputs).length > 0;
    for (const [file, expected] of Object.entries(outputs)) {
      if (!fs.existsSync(file)) { upToDate = false; break; }
      if (expected && expected !== file) {
        const actual = await sha1File(file);
        if (actual !== String(expected).replace(/'/g, '')) { upToDate = false; break; }
      }
    }
    if (upToDate) continue;

    const jar = libPath(proc.jar);
    if (!fs.existsSync(jar)) throw new Error('Не найден jar процессора: ' + proc.jar);
    const mainClass = readMainClass(jar);
    if (!mainClass) throw new Error('В ' + path.basename(jar) + ' не указан Main-Class');

    const cp = [jar, ...(proc.classpath || []).map(libPath)];
    const args = (proc.args || []).map((a) => resolveArg(a, data));
    await runJava(javaInfo.path, ['-cp', cp.join(path.delimiter), mainClass, ...args], workDir);
  }

  report({ stage: 'loader', label: kind + ' установлен', done: 1, total: 1 });
  fs.rmSync(workDir, { recursive: true, force: true });
  return { versionId: versionJson.id, loaderVersion };
}

module.exports = { listForge, listNeoForge, install, neoToMc, neoPrefix, parseMavenMetadata };
