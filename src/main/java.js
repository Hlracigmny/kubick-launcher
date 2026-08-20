'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');
const P = require('./paths');
const { downloadFile } = require('./net');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'java.exe' : 'java';
// javaw не открывает лишнее консольное окно на Windows
const EXE_SILENT = IS_WIN ? 'javaw.exe' : 'java';

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, out: String(stdout || '') + String(stderr || '') });
    });
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

async function probe(javaPath) {
  if (!javaPath || !fs.existsSync(javaPath)) return null;
  const { err, out } = await run(javaPath, ['-version']);
  if (err && !out) return null;
  const major = parseMajor(out);
  if (!major) return null;
  const is64 = /64-Bit/i.test(out) || !/Client VM/i.test(out);
  return { path: javaPath, major, arch64: is64, raw: out.split('\n')[0].trim() };
}

function candidateDirs() {
  const dirs = [];
  if (process.env.JAVA_HOME) dirs.push(process.env.JAVA_HOME);

  if (IS_WIN) {
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null,
    ].filter(Boolean);
    const vendors = ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'AdoptOpenJDK', 'Amazon Corretto', 'Microsoft', 'Zulu', 'BellSoft', 'Semeru'];
    for (const root of roots) {
      for (const vendor of vendors) {
        const dir = path.join(root, vendor);
        try {
          for (const entry of fs.readdirSync(dir)) dirs.push(path.join(dir, entry));
        } catch {
          // вендор не установлен
        }
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
      } catch {
        // официального лаунчера нет
      }
    }
  } else {
    dirs.push('/usr/lib/jvm', '/usr/local/opt', '/Library/Java/JavaVirtualMachines');
    for (const base of ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines']) {
      try {
        for (const e of fs.readdirSync(base)) dirs.push(path.join(base, e), path.join(base, e, 'Contents', 'Home'));
      } catch {
        // каталога нет
      }
    }
  }

  // Ранее скачанные лаунчером рантаймы
  try {
    for (const e of fs.readdirSync(P.java)) dirs.push(path.join(P.java, e));
  } catch {
    // ещё ничего не качали
  }
  return dirs;
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
  } catch {
    // не каталог
  }
  return null;
}

let scanCache = null;

/** Находит все доступные в системе Java. Результат кешируется на время сессии. */
async function scan(force = false) {
  if (scanCache && !force) return scanCache;
  const seen = new Set();
  const found = [];

  const pathJava = await probe(IS_WIN ? 'java.exe' : 'java').catch(() => null);
  if (pathJava) { found.push(pathJava); seen.add(pathJava.path); }

  for (const dir of candidateDirs()) {
    const bin = binIn(dir);
    if (!bin || seen.has(bin)) continue;
    seen.add(bin);
    const info = await probe(bin);
    if (info) found.push(info);
  }
  found.sort((a, b) => b.major - a.major);
  scanCache = found;
  return found;
}

/** Какая мажорная версия Java нужна конкретной версии Minecraft. */
function requiredMajor(version) {
  if (version && version.javaVersion && version.javaVersion.majorVersion) {
    return version.javaVersion.majorVersion;
  }
  const id = String((version && (version.inheritsFrom || version.id)) || '');
  const m = /^1\.(\d+)/.exec(id);
  const minor = m ? parseInt(m[1], 10) : 99;
  if (minor >= 21) return 21;
  if (minor >= 18) return 17;
  if (minor >= 17) return 16;
  return 8;
}

function adoptiumUrl(major, imageType) {
  const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'ia32' ? 'x86' : 'x64';
  return 'https://api.adoptium.net/v3/binary/latest/' + major + '/ga/' + osName + '/' + arch +
    '/' + imageType + '/hotspot/normal/eclipse';
}

/** Скачивает и распаковывает Temurin нужной мажорной версии в runtime лаунчера. */
async function install(major, onProgress) {
  const report = onProgress || (() => {});
  const target = path.join(P.java, 'temurin-' + major);
  const existing = binIn(target);
  if (existing) {
    const info = await probe(existing);
    if (info) return info;
  }

  fs.mkdirSync(P.java, { recursive: true });
  const isZip = IS_WIN;
  const archive = path.join(P.cache, 'jre-' + major + (isZip ? '.zip' : '.tar.gz'));

  report({ stage: 'java', label: 'Загрузка Java ' + major, done: 0, total: 1 });
  let ok = false;
  for (const imageType of ['jre', 'jdk']) {
    try {
      await downloadFile(adoptiumUrl(major, imageType), archive, { attempts: 3 });
      ok = true;
      break;
    } catch {
      // для некоторых версий/платформ бывает только jdk
    }
  }
  if (!ok) throw new Error('Не удалось скачать Java ' + major + '. Укажите путь к java вручную в настройках.');

  report({ stage: 'java', label: 'Распаковка Java ' + major, done: 0, total: 1 });
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  if (isZip) {
    new AdmZip(archive).extractAllTo(target, true);
  } else {
    await new Promise((resolve, reject) => {
      execFile('tar', ['-xzf', archive, '-C', target], (err) => (err ? reject(err) : resolve()));
    });
    const bin = binIn(target);
    if (bin) fs.chmodSync(bin, 0o755);
  }
  fs.rmSync(archive, { force: true });

  const bin = binIn(target);
  if (!bin) throw new Error('Java распакована, но исполняемый файл не найден в ' + target);
  if (!IS_WIN) fs.chmodSync(bin, 0o755);

  scanCache = null;
  const info = await probe(bin);
  if (!info) throw new Error('Скачанная Java не запускается');
  report({ stage: 'java', label: 'Java ' + major + ' готова', done: 1, total: 1 });
  return info;
}

/**
 * Возвращает путь к java, подходящей для версии игры.
 * Приоритет: явная настройка -> уже установленная подходящая -> автозагрузка.
 */
async function resolveJava(version, settings, onProgress) {
  const need = requiredMajor(version);
  const opts = settings || {};

  if (opts.javaPath) {
    const info = await probe(opts.javaPath);
    if (!info) throw new Error('Java по указанному пути не найдена или не запускается: ' + opts.javaPath);
    return { ...info, required: need, manual: true };
  }

  const all = await scan();
  // Точное совпадение мажорной версии надёжнее, чем «просто новее»
  const exact = all.find((j) => j.major === need);
  if (exact) return { ...exact, required: need };

  // Для 1.17+ более новая LTS обычно работает; для 1.16 и старше — нет
  if (need >= 17) {
    const newer = all.find((j) => j.major >= need && j.major <= need + 4);
    if (newer) return { ...newer, required: need };
  }

  const installed = await install(need, onProgress);
  return { ...installed, required: need };
}

function silentBinary(javaPath) {
  const dir = path.dirname(javaPath);
  const silent = path.join(dir, EXE_SILENT);
  return fs.existsSync(silent) ? silent : javaPath;
}

module.exports = { scan, probe, requiredMajor, install, resolveJava, silentBinary, parseMajor, hostArch: os.arch() };
