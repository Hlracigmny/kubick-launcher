'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');
const P = require('./paths');
const { downloadFile, fetchJson } = require('./net');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'java.exe' : 'java';
// javaw не открывает лишнее консольное окно на Windows
const EXE_SILENT = IS_WIN ? 'javaw.exe' : 'java';

const MATRIX = require('./java-matrix.json');

/**
 * Поиск, проверка и установка Java.
 *
 * Главная мысль: «новее» не значит «лучше». Старые версии Minecraft и особенно
 * старый Forge держатся на том, что из новых JDK убрали — внутренние пакеты,
 * закрытые в JDK 9, ключ --illegal-access, убранный в 17, sun.misc.Unsafe,
 * который начал ругаться в 24 и уходит совсем. Поэтому у каждой версии игры
 * есть не только нижняя граница по Java, но и верхняя, и подобрать Java 25
 * под 1.12.2 — гарантированное падение, а не «сойдёт».
 */

/* ------------------------- Матрица совместимости ------------------------ */

/** Сравнение версий Minecraft по числам: «1.9» больше «1.10» только по алфавиту. */
function compareMcVersions(a, b) {
  const pa = String(a).split(/[.\-+_]/);
  const pb = String(b).split(/[.\-+_]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i], 10);
    const nb = parseInt(pb[i], 10);
    const va = Number.isNaN(na) ? -1 : na;
    const vb = Number.isNaN(nb) ? -1 : nb;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/** Версия игры из профиля: у Fabric и Forge она в inheritsFrom, а не в id. */
function gameVersionOf(version) {
  if (!version) return '';
  if (version.inheritsFrom) return String(version.inheritsFrom);
  const id = String(version.id || '');
  // «fabric-loader-0.16.5-1.21.1» -> «1.21.1»
  const embedded = /(\d+\.\d+(?:\.\d+)?)$/.exec(id);
  return embedded ? embedded[1] : id;
}

/**
 * Требования к Java для версии игры: сколько нужно и выше чего нельзя.
 * Манифест Mojang главнее матрицы — там значение от самого разработчика.
 */
function requirementFor(version) {
  const mc = gameVersionOf(version);
  const rule = MATRIX.rules.find((r) => {
    const aboveMin = !r.minVersion || compareMcVersions(mc, r.minVersion) >= 0;
    const belowMax = !r.maxVersion || compareMcVersions(mc, r.maxVersion) <= 0;
    return aboveMin && belowMax;
  }) || MATRIX.rules[0];

  const fromManifest = version && version.javaVersion && version.javaVersion.majorVersion;
  return {
    required: fromManifest || rule.required,
    max: rule.max,
    note: rule.note,
    source: fromManifest ? 'манифест версии' : 'матрица совместимости',
    mcVersion: mc,
  };
}

/** Совместима ли конкретная Java с этой версией игры. */
function fits(major, requirement) {
  if (major < requirement.required) return false;
  if (requirement.max != null && major > requirement.max) return false;
  return true;
}

/** Обратная совместимость: раньше наружу отдавалась только нижняя граница. */
function requiredMajor(version) {
  return requirementFor(version).required;
}

/* ------------------------------ Проверка ------------------------------- */

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ err, out: String(stdout || '') + String(stderr || '') });
      });
    } catch (err) {
      // Указали не исполняемый файл — Windows бросает это прямо из spawn,
      // мимо колбэка. Ошибку глотаем: наверх уйдёт понятное «это не Java».
      resolve({ err, out: '' });
    }
  });
}

/** "1.8.0_401" -> 8, "17.0.9" -> 17 */
function parseMajor(text) {
  const m = /version "([^"]+)"/.exec(text) || /openjdk version ([\d._]+)/.exec(text);
  if (!m) return null;
  const v = m[1];
  if (v.startsWith('1.')) return parseInt(v.split('.')[1], 10) || null;
  return parseInt(v.split('.')[0], 10) || null;
}

/**
 * Файл release рядом с bin — быстрый путь: версия читается без запуска процесса.
 * Запуск java занимает сотни миллисекунд, а кандидатов бывает полтора десятка.
 */
function readReleaseFile(javaPath) {
  const home = path.dirname(path.dirname(javaPath));
  let text = '';
  try { text = fs.readFileSync(path.join(home, 'release'), 'utf8'); } catch { return null; }

  const version = /^JAVA_VERSION="?([^"\r\n]+)"?/m.exec(text);
  if (!version) return null;
  const raw = version[1];
  const major = raw.startsWith('1.') ? parseInt(raw.split('.')[1], 10) : parseInt(raw.split('.')[0], 10);
  if (!major) return null;

  const arch = /^OS_ARCH="?([^"\r\n]+)"?/m.exec(text);
  const vendor = /^IMPLEMENTOR="?([^"\r\n]+)"?/m.exec(text);
  return {
    major,
    version: raw,
    arch64: !arch || /64/.test(arch[1]),
    vendor: vendor ? vendor[1] : null,
  };
}

/**
 * Проверяет кандидата. Возвращает null, если это не рабочая Java —
 * именно поэтому версия определяется чтением, а не именем папки:
 * в «C:\Program Files\Java\jre1.8.0_401» может лежать что угодно.
 */
async function probe(javaPath, { quick = false } = {}) {
  if (!javaPath) return null;
  // java из PATH задаётся именем без пути — существование проверит сам запуск
  const looksLikePath = javaPath.includes(path.sep) || javaPath.includes('/');
  if (looksLikePath && !fs.existsSync(javaPath)) return null;

  if (quick && looksLikePath) {
    const release = readReleaseFile(javaPath);
    if (release) {
      return {
        path: javaPath,
        major: release.major,
        version: release.version,
        arch64: release.arch64,
        vendor: release.vendor,
        raw: 'release: ' + release.version,
      };
    }
  }

  const { err, out } = await run(javaPath, ['-version']);
  if (err && !out) return null;
  const major = parseMajor(out);
  if (!major) return null;
  const full = /version "([^"]+)"/.exec(out);
  return {
    path: javaPath,
    major,
    version: full ? full[1] : String(major),
    arch64: /64-Bit/i.test(out) || !/Client VM/i.test(out),
    vendor: null,
    raw: out.split('\n')[0].trim(),
  };
}

/** Явная проверка пути для настроек: объясняет, что именно не так. */
async function validate(javaPath) {
  const clean = String(javaPath || '').trim();
  if (!clean) return { ok: false, error: 'Путь не указан' };

  let stat = null;
  try { stat = fs.statSync(clean); } catch { return { ok: false, error: 'Файл не найден: ' + clean }; }
  if (stat.isDirectory()) {
    const inside = binIn(clean);
    if (!inside) return { ok: false, error: 'Это папка. Укажите файл ' + EXE + ' внутри неё, в подпапке bin' };
    return validate(inside);
  }

  const name = path.basename(clean).toLowerCase();
  if (!/^javaw?(\.exe)?$/.test(name)) {
    return { ok: false, error: 'Ожидается файл ' + EXE + ', а выбран ' + path.basename(clean) };
  }

  const info = await probe(clean);
  if (!info) return { ok: false, error: 'Файл есть, но это не рабочая Java — запустить не удалось' };
  if (!info.arch64 && os.arch() === 'x64') {
    return { ok: true, info, warning: '32-битная Java: больше 1.5 ГБ памяти игре выделить не получится' };
  }
  return { ok: true, info };
}

/* ------------------------------- Поиск --------------------------------- */

/**
 * Приоритет источников. Меньше число — надёжнее источник.
 * Рантайм лаунчера первый не из вежливости: он скачан под конкретную версию
 * игры и заведомо той разрядности, что нужна.
 */
const SOURCE_PRIORITY = {
  runtime: 0,     // скачано самим лаунчером
  manual: 1,      // путь из настроек
  javaHome: 2,    // JAVA_HOME
  registry: 3,    // реестр Windows
  wellKnown: 4,   // типовые папки установки
  path: 5,        // java в PATH
};

/** Ветки реестра, куда пишутся установщики Java. */
const REGISTRY_KEYS = [
  ['HKLM\\SOFTWARE\\JavaSoft\\JDK', 'JavaHome'],
  ['HKLM\\SOFTWARE\\JavaSoft\\JRE', 'JavaHome'],
  ['HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit', 'JavaHome'],
  ['HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment', 'JavaHome'],
  ['HKLM\\SOFTWARE\\Eclipse Adoptium\\JDK', 'Path'],
  ['HKLM\\SOFTWARE\\Eclipse Adoptium\\JRE', 'Path'],
  ['HKLM\\SOFTWARE\\Eclipse Foundation\\JDK', 'Path'],
  ['HKLM\\SOFTWARE\\AdoptOpenJDK\\JDK', 'Path'],
  ['HKLM\\SOFTWARE\\Azul Systems\\Zulu', 'InstallationPath'],
  ['HKLM\\SOFTWARE\\Amazon\\Corretto', 'JavaHome'],
  ['HKLM\\SOFTWARE\\Microsoft\\JDK', 'Path'],
  ['HKLM\\SOFTWARE\\BellSoft\\Liberica', 'InstallationPath'],
  // 32-битные установщики на 64-битной системе пишут сюда
  ['HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\JDK', 'JavaHome'],
  ['HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Runtime Environment', 'JavaHome'],
  ['HKLM\\SOFTWARE\\WOW6432Node\\Eclipse Adoptium\\JRE', 'Path'],
];

/**
 * Читает пути установки Java из реестра Windows.
 * Ключи вложенные: под веткой вендора лежат подключи по версиям,
 * поэтому запрашиваем рекурсивно и вылавливаем нужные значения.
 */
async function registryHomes() {
  if (!IS_WIN) return [];
  const homes = new Set();

  await Promise.all(REGISTRY_KEYS.map(async ([key, valueName]) => {
    // /s — рекурсивно по подключам версий, /v — только интересующее значение
    const { out } = await run('reg', ['query', key, '/s', '/v', valueName], 6000);
    if (!out) return;
    const re = new RegExp('^\\s+' + valueName + '\\s+REG_SZ\\s+(.+)$', 'gmi');
    let m;
    while ((m = re.exec(out)) !== null) {
      const home = m[1].trim();
      if (home) homes.add(home);
    }
  }));

  return [...homes];
}

/** Типовые папки установки — на случай, если в реестре ничего нет. */
function wellKnownDirs() {
  const dirs = [];
  if (IS_WIN) {
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null,
    ].filter(Boolean);
    const vendors = ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'AdoptOpenJDK',
      'Amazon Corretto', 'Microsoft', 'Zulu', 'BellSoft', 'Semeru', 'Liberica'];
    for (const root of roots) {
      for (const vendor of vendors) {
        const dir = path.join(root, vendor);
        try {
          for (const entry of fs.readdirSync(dir)) dirs.push(path.join(dir, entry));
        } catch { /* вендор не установлен */ }
      }
    }
    // Java, поставляемая официальным лаунчером Mojang
    const mojang = process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Minecraft Launcher', 'runtime') : null;
    if (mojang) {
      try {
        for (const a of fs.readdirSync(mojang)) {
          for (const b of fs.readdirSync(path.join(mojang, a))) {
            dirs.push(path.join(mojang, a, b, path.basename(b)));
          }
        }
      } catch { /* официального лаунчера нет */ }
    }
  } else {
    for (const base of ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines', '/usr/local/opt']) {
      try {
        for (const e of fs.readdirSync(base)) {
          dirs.push(path.join(base, e), path.join(base, e, 'Contents', 'Home'));
        }
      } catch { /* каталога нет */ }
    }
  }
  return dirs;
}

/** Рантаймы, скачанные самим лаунчером. */
function runtimeDirs() {
  try {
    return fs.readdirSync(P.java).map((e) => path.join(P.java, e));
  } catch {
    return [];
  }
}

function binIn(dir) {
  const direct = path.join(dir, 'bin', EXE);
  if (fs.existsSync(direct)) return direct;
  const macOs = path.join(dir, 'Contents', 'Home', 'bin', EXE);
  if (fs.existsSync(macOs)) return macOs;
  // распакованный архив кладёт всё в подпапку вида jdk-21.0.4+7-jre
  try {
    for (const e of fs.readdirSync(dir)) {
      const nested = path.join(dir, e, 'bin', EXE);
      if (fs.existsSync(nested)) return nested;
      const nestedMac = path.join(dir, e, 'Contents', 'Home', 'bin', EXE);
      if (fs.existsSync(nestedMac)) return nestedMac;
    }
  } catch { /* не каталог */ }
  return null;
}

/* ------------------------------- Кеш ----------------------------------- */

const CACHE_FILE = () => path.join(P.cache, 'java-scan.json');
const CACHE_TTL = 24 * 60 * 60 * 1000;

let memoryCache = null;

function readCache() {
  if (memoryCache) return memoryCache;
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE(), 'utf8'));
    if (!data || !Array.isArray(data.list)) return null;
    if (Date.now() - (data.at || 0) > CACHE_TTL) return null;
    // Java могли удалить со времени прошлого запуска — пути перепроверяем
    const alive = data.list.filter((j) => j.path && (!j.path.includes(path.sep) || fs.existsSync(j.path)));
    if (alive.length !== data.list.length) return null;
    memoryCache = alive;
    return alive;
  } catch {
    return null;
  }
}

function writeCache(list) {
  memoryCache = list;
  try {
    fs.mkdirSync(P.cache, { recursive: true });
    fs.writeFileSync(CACHE_FILE(), JSON.stringify({ at: Date.now(), list }, null, 2), 'utf8');
  } catch { /* кеш необязателен */ }
}

function invalidate() {
  memoryCache = null;
  try { fs.rmSync(CACHE_FILE(), { force: true }); } catch { /* нечего удалять */ }
}

/* ------------------------------- Скан ---------------------------------- */

/**
 * Находит все доступные Java, помечая источник каждой.
 * Результат кешируется на сутки и переживает перезапуск лаунчера:
 * обход реестра и запуск десятка процессов заметно тормозят старт.
 */
async function scan(force = false, settings = null) {
  if (!force) {
    const cached = readCache();
    if (cached) return cached;
  }

  const candidates = [];
  const add = (bin, source) => {
    if (bin) candidates.push({ bin, source });
  };

  // 1. Рантайм лаунчера
  for (const dir of runtimeDirs()) add(binIn(dir), 'runtime');
  // 2. Путь из настроек
  if (settings && settings.javaPath) add(settings.javaPath, 'manual');
  // 3. JAVA_HOME
  if (process.env.JAVA_HOME) add(binIn(process.env.JAVA_HOME), 'javaHome');
  // 4. Реестр Windows
  for (const home of await registryHomes()) add(binIn(home), 'registry');
  // 5. Типовые папки
  for (const dir of wellKnownDirs()) add(binIn(dir), 'wellKnown');
  // 6. java в PATH — последним: неизвестно, куда он ведёт
  add(IS_WIN ? 'java.exe' : 'java', 'path');

  const seen = new Set();
  const found = [];
  for (const { bin, source } of candidates) {
    const key = bin.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Быстрый путь через release; если его нет — запускаем java -version
    const info = await probe(bin, { quick: true });
    if (info) found.push({ ...info, source, priority: SOURCE_PRIORITY[source] });
  }

  // Сначала надёжный источник, при равенстве — свежая версия
  found.sort((a, b) => a.priority - b.priority || b.major - a.major);
  writeCache(found);
  return found;
}

/* ----------------------------- Установка -------------------------------- */

const ADOPTIUM_API = 'https://api.adoptium.net/v3';

function adoptiumPlatform() {
  return {
    os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux',
    arch: process.arch === 'arm64' ? 'aarch64' : process.arch === 'ia32' ? 'x86' : 'x64',
  };
}

/**
 * Метаданные сборки Temurin: ссылка и контрольная сумма.
 *
 * Ходим именно за метаданными, а не сразу за файлом, ради checksum: Adoptium
 * отдаёт sha256 для каждого архива, и без него скачанное нечем проверить —
 * оборванная загрузка распаковалась бы в битую Java.
 */
async function adoptiumBinary(major, imageType) {
  const { os: osName, arch } = adoptiumPlatform();
  const url = ADOPTIUM_API + '/assets/latest/' + major + '/hotspot' +
    '?architecture=' + arch + '&image_type=' + imageType + '&os=' + osName +
    '&vendor=eclipse&jvm_impl=hotspot';

  const list = await fetchJson(url, { attempts: 2, timeout: 20000 });
  const entry = (list || []).find((a) => a && a.binary && a.binary.package && a.binary.package.link);
  if (!entry) return null;

  const pkg = entry.binary.package;
  return {
    url: pkg.link,
    sha256: pkg.checksum || null,
    size: pkg.size || 0,
    name: pkg.name || ('jre-' + major),
    release: entry.release_name || null,
  };
}

/** Скачивает и распаковывает Temurin нужной мажорной версии в runtime лаунчера. */
async function install(major, onProgress) {
  const report = onProgress || (() => {});
  const target = path.join(P.java, 'temurin-' + major);

  const existing = binIn(target);
  if (existing) {
    const info = await probe(existing);
    if (info && info.major === major) return { ...info, source: 'runtime', priority: 0 };
  }

  fs.mkdirSync(P.java, { recursive: true });
  report({ stage: 'java', label: 'Ищем сборку Java ' + major, done: 0, total: 1 });

  // jre меньше и достаточно для игры; jdk берём, если jre под эту версию не собирают
  let binary = null;
  for (const imageType of ['jre', 'jdk']) {
    try {
      binary = await adoptiumBinary(major, imageType);
      if (binary) break;
    } catch { /* попробуем следующий тип образа */ }
  }
  if (!binary) {
    throw new Error('Не удалось найти сборку Java ' + major + ' для этой системы. ' +
      'Укажите путь к java вручную в настройках.');
  }

  const archive = path.join(P.cache, binary.name);
  report({ stage: 'java', label: 'Загрузка Java ' + major + ' (' + Math.round(binary.size / 1048576) + ' МБ)', done: 0, total: 1 });
  await downloadFile(binary.url, archive, {
    sha256: binary.sha256,
    size: binary.size || undefined,
    attempts: 3,
  });

  report({ stage: 'java', label: 'Распаковка Java ' + major, done: 0, total: 1 });
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  if (/\.zip$/i.test(binary.name)) {
    new AdmZip(archive).extractAllTo(target, true);
  } else {
    await new Promise((resolve, reject) => {
      execFile('tar', ['-xzf', archive, '-C', target], (err) => (err ? reject(err) : resolve()));
    });
  }
  fs.rmSync(archive, { force: true });

  const bin = binIn(target);
  if (!bin) throw new Error('Java распакована, но исполняемый файл не найден в ' + target);
  if (!IS_WIN) {
    try { fs.chmodSync(bin, 0o755); } catch { /* права уже есть */ }
  }

  invalidate();
  const info = await probe(bin);
  if (!info) throw new Error('Скачанная Java не запускается');
  report({ stage: 'java', label: 'Java ' + major + ' готова', done: 1, total: 1 });
  return { ...info, source: 'runtime', priority: 0 };
}

/* ------------------------------ Подбор --------------------------------- */

/** Ошибка, по которой интерфейс понимает, что можно предложить скачать Java. */
class JavaNeededError extends Error {
  constructor(requirement, available) {
    const have = available.length
      ? 'Найдено: ' + available.map((j) => 'Java ' + j.major).join(', ')
      : 'Java в системе не найдена';
    super('Для Minecraft ' + requirement.mcVersion + ' нужна Java ' + requirement.required +
      '. ' + have + '.');
    this.name = 'JavaNeededError';
    this.code = 'JAVA_REQUIRED';
    this.requirement = requirement;
    this.available = available.map((j) => ({ major: j.major, path: j.path, source: j.source }));
  }
}

/**
 * Возвращает путь к java, подходящей для версии игры.
 *
 * Порядок такой: явно указанный путь — если он подходит; затем уже найденная
 * подходящая Java, начиная с рантайма лаунчера; и только потом загрузка.
 * Ключевое отличие от прежнего поведения — проверка верхней границы:
 * Java 25 под 1.12.2 больше не выбирается.
 */
async function resolveJava(version, settings, onProgress) {
  const requirement = requirementFor(version);
  const opts = settings || {};

  // Указанный вручную путь уважаем, но не молчим, если он не подходит
  if (opts.javaPath) {
    const info = await probe(opts.javaPath);
    if (!info) {
      throw new Error('Java по указанному пути не запускается: ' + opts.javaPath +
        '. Исправьте путь в настройках или очистите поле, чтобы лаунчер выбрал сам.');
    }
    if (!fits(info.major, requirement)) {
      const limit = requirement.max != null && info.major > requirement.max
        ? 'Java ' + info.major + ' для неё слишком новая (подходит до ' + requirement.max + ' включительно).'
        : 'Java ' + info.major + ' для неё слишком старая.';
      throw new Error('В настройках указана Java ' + info.major + ', а Minecraft ' +
        requirement.mcVersion + ' требует Java ' + requirement.required + '. ' + limit +
        ' ' + (requirement.note || ''));
    }
    return { ...info, required: requirement.required, requirement, manual: true };
  }

  const all = await scan(false, opts);

  // Точное совпадение надёжнее всего
  const exact = all.find((j) => j.major === requirement.required);
  if (exact) return { ...exact, required: requirement.required, requirement };

  // Иначе — любая подходящая по обеим границам, в порядке надёжности источника
  const compatible = all.find((j) => fits(j.major, requirement));
  if (compatible) return { ...compatible, required: requirement.required, requirement };

  // Ничего подходящего нет: качаем. Вызывающий может перехватить и спросить пользователя.
  if (opts.autoInstallJava === false) throw new JavaNeededError(requirement, all);

  const installed = await install(requirement.required, onProgress);
  return { ...installed, required: requirement.required, requirement };
}

function silentBinary(javaPath) {
  const dir = path.dirname(javaPath);
  const silent = path.join(dir, EXE_SILENT);
  return fs.existsSync(silent) ? silent : javaPath;
}

module.exports = {
  scan, probe, validate, install, resolveJava, silentBinary, parseMajor,
  requiredMajor, requirementFor, fits, compareMcVersions, gameVersionOf,
  invalidate, readReleaseFile, registryHomes,
  JavaNeededError, MATRIX,
  hostArch: os.arch(),
};
