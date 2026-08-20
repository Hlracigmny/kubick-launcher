'use strict';
const path = require('path');

const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
const OS_ARCH = process.arch === 'ia32' ? 'x86'
  : process.arch === 'arm64' ? 'arm64'
  : process.arch === 'arm' ? 'arm'
  : 'x64';

function matchOs(osRule) {
  if (!osRule) return true;
  if (osRule.name && osRule.name !== OS_NAME) return false;
  if (osRule.arch && osRule.arch !== OS_ARCH) return false;
  if (osRule.version) {
    try { if (!new RegExp(osRule.version).test(require('os').release())) return false; }
    catch { /* битый regex в манифесте не должен ронять запуск */ }
  }
  return true;
}

/**
 * Правила Mojang вычисляются по принципу «последнее совпавшее выигрывает»,
 * а по умолчанию (если правила есть, но ни одно не совпало) — запрещено.
 */
function rulesAllow(rules, features = {}) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let ok = true;
    if (rule.os && !matchOs(rule.os)) ok = false;
    if (ok && rule.features) {
      for (const [k, v] of Object.entries(rule.features)) {
        if (Boolean(features[k]) !== Boolean(v)) { ok = false; break; }
      }
    }
    if (ok) allowed = rule.action === 'allow';
  }
  return allowed;
}

/** "net.fabricmc:tiny-mappings-parser:0.3.0" -> относительный путь в libraries/ */
function mavenToPath(name) {
  const [coords, ext = 'jar'] = String(name).split('@');
  const parts = coords.split(':');
  const [group, artifact, version] = parts;
  const classifier = parts[3];
  const file = classifier
    ? `${artifact}-${version}-${classifier}.${ext}`
    : `${artifact}-${version}.${ext}`;
  return path.join(...group.split('.'), artifact, version, file);
}

function mavenToUrl(base, name) {
  const rel = mavenToPath(name).split(path.sep).join('/');
  return base.replace(/\/+$/, '') + '/' + rel;
}

const NATIVE_OS_ALIAS = { windows: 'windows', macos: 'osx', osx: 'osx', linux: 'linux' };
const NATIVE_ARCH_ALIAS = { x86: 'x86', x64: 'x64', arm64: 'arm64', arm32: 'arm', arm: 'arm' };

/**
 * Проверяет, подходит ли нативная библиотека этой машине.
 *
 * Критично: в манифесте Mojang у natives-windows, natives-windows-x86 и natives-windows-arm64
 * совершенно одинаковые rules — только {"os":{"name":"windows"}}. Архитектура закодирована
 * в самом классификаторе. Если полагаться только на rules, распаковываются все три архитектуры
 * в одну папку, и 32-битная lwjgl.dll затирает 64-битную — игра падает с
 * UnsatisfiedLinkError: Failed to locate library.
 */
function nativeFitsHost(name) {
  const classifier = String(name || '').split(':')[3] || '';
  if (!classifier.startsWith('natives')) return true;

  const parts = classifier.split('-');
  const osPart = NATIVE_OS_ALIAS[parts[1]];
  if (osPart && osPart !== OS_NAME) return false;

  const archPart = parts.slice(2).join('-');
  if (!archPart) return OS_ARCH === 'x64'; // без суффикса классификатор означает x64
  const arch = NATIVE_ARCH_ALIAS[archPart];
  if (!arch) return true; // незнакомый суффикс — не архитектура, не отбрасываем
  return arch === OS_ARCH;
}

/** Ключ classifier для нативных библиотек старого формата (natives-windows и т.п.) */
function nativeClassifier(lib) {
  if (!lib.natives) return null;
  const raw = lib.natives[OS_NAME];
  if (!raw) return null;
  return raw.replace('${arch}', OS_ARCH === 'x86' ? '32' : '64');
}

/** Разворачивает ${placeholder} в строках аргументов запуска. */
function substitute(value, vars) {
  return String(value).replace(/\$\{([^}]+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

/** Превращает arguments.game / arguments.jvm в плоский список строк с учётом правил. */
function flattenArguments(list, vars, features) {
  const out = [];
  for (const entry of list || []) {
    if (typeof entry === 'string') { out.push(substitute(entry, vars)); continue; }
    if (!entry || !rulesAllow(entry.rules, features)) continue;
    const values = Array.isArray(entry.value) ? entry.value : [entry.value];
    for (const v of values) if (v != null) out.push(substitute(v, vars));
  }
  return out;
}

/**
 * Наследование версий: Fabric/Forge отдают json с полем inheritsFrom.
 * Родитель применяется первым, дочерние поля переопределяют его.
 */
function mergeVersions(parent, child) {
  const merged = { ...parent, ...child };
  merged.libraries = [...(child.libraries || []), ...(parent.libraries || [])];
  merged.mainClass = child.mainClass || parent.mainClass;
  merged.assetIndex = child.assetIndex || parent.assetIndex;
  merged.assets = child.assets || parent.assets;
  merged.downloads = parent.downloads || child.downloads;
  merged.javaVersion = child.javaVersion || parent.javaVersion;
  merged.logging = child.logging || parent.logging;

  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [...((parent.arguments && parent.arguments.game) || []), ...((child.arguments && child.arguments.game) || [])],
      jvm: [...((parent.arguments && parent.arguments.jvm) || []), ...((child.arguments && child.arguments.jvm) || [])],
    };
  }
  if (child.minecraftArguments) merged.minecraftArguments = child.minecraftArguments;
  else if (parent.minecraftArguments) merged.minecraftArguments = parent.minecraftArguments;
  delete merged.inheritsFrom;
  return merged;
}

/**
 * Оставляет по одной библиотеке на пару group:artifact — с наибольшей версией.
 * Без этого Forge/Fabric тянут дубликаты в classpath и игра падает на старте.
 *
 * Нативы считаются отдельной библиотекой. В манифестах 1.13–1.18 одна и та же
 * координата перечислена дважды: один раз как jar с классами, второй — с полем
 * natives и классификаторами. Имя у обеих записей одинаковое, и без пометки
 * в ключе натив вытеснялся классами: папка нативов оставалась пустой,
 * а игра падала с UnsatisfiedLinkError.
 */
function dedupeLibraries(libs) {
  const best = new Map();
  const order = [];
  for (const lib of libs) {
    if (!lib || !lib.name) continue;
    const parts = lib.name.split(':');
    const key = parts[0] + ':' + parts[1] + ':' + (parts[3] || '') + (lib.natives ? ':natives' : '');
    const version = parts[2] || '0';
    const prev = best.get(key);
    if (!prev) { best.set(key, { lib, version }); order.push(key); continue; }
    if (compareVersions(version, prev.version) > 0) best.set(key, { lib, version });
  }
  return order.map((k) => best.get(k).lib);
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+_]/);
  const pb = String(b).split(/[.\-+_]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i], 10); const nb = parseInt(pb[i], 10);
    const va = Number.isNaN(na) ? -1 : na;
    const vb = Number.isNaN(nb) ? -1 : nb;
    if (va !== vb) return va - vb;
    if (va === -1) {
      const sa = pa[i] || ''; const sb = pb[i] || '';
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

module.exports = {
  OS_NAME, OS_ARCH, rulesAllow, mavenToPath, mavenToUrl, nativeClassifier, nativeFitsHost,
  substitute, flattenArguments, mergeVersions, dedupeLibraries, compareVersions,
};
