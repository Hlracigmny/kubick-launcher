'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const P = require('../paths');
const R = require('./rules');
const { installVersion } = require('./install');
const javaMod = require('../java');

const CP_SEP = process.platform === 'win32' ? ';' : ':';
const LAUNCHER_NAME = 'KubickLauncher';
const LAUNCHER_VERSION = require('../../../package.json').version;

const UNLOCK_EXPERIMENTAL = '-XX:+UnlockExperimentalVMOptions';
const EXPERIMENTAL_VM_OPTIONS = /^-XX:(G1NewSizePercent|G1MaxNewSizePercent|G1MixedGCLiveThresholdPercent|G1RSetUpdatingPauseTimePercent|\+?ZGenerational|\+?UseShenandoahGC)/;

const running = new Map(); // instanceId -> { child, startedAt, log: [] }

function assetsRootFor(version) {
  const idx = version.assets || (version.assetIndex && version.assetIndex.id) || 'legacy';
  if (idx === 'legacy' || idx === 'pre-1.6') return path.join(P.assets, 'virtual', 'legacy');
  return P.assets;
}

/**
 * Собирает полный список аргументов JVM и игры.
 * Поддерживает и современный формат (arguments.jvm/game), и старый (minecraftArguments).
 */
function buildCommand({ version, classpath, nativesDir, jarPath, gameDir, account, settings, javaInfo, server }) {
  const memory = Math.max(512, parseInt(settings.memoryMb, 10) || 2048);
  const fullClasspath = [...classpath, jarPath].filter((p, i, arr) => p && arr.indexOf(p) === i);

  const features = {
    is_demo_user: false,
    has_custom_resolution: Boolean(settings.width && settings.height) && !settings.fullscreen,
    // Прямое подключение к серверу: Minecraft умеет это с 1.20.
    // На старых версиях таких аргументов в манифесте нет, и они просто не подставятся.
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: Boolean(server),
    is_quick_play_realms: false,
  };

  const vars = {
    auth_player_name: account.name,
    version_name: version.id,
    game_directory: gameDir,
    assets_root: assetsRootFor(version),
    game_assets: assetsRootFor(version),
    assets_index_name: (version.assetIndex && version.assetIndex.id) || version.assets || 'legacy',
    auth_uuid: account.uuid,
    auth_access_token: account.accessToken || '0',
    auth_session: 'token:' + (account.accessToken || '0') + ':' + account.uuid,
    auth_xuid: account.xuid || '0',
    clientid: account.clientId || '0',
    user_type: account.type === 'microsoft' ? 'msa' : 'legacy',
    version_type: version.type || 'release',
    user_properties: '{}',
    resolution_width: String(settings.width || 1280),
    resolution_height: String(settings.height || 720),
    natives_directory: nativesDir,
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    classpath: fullClasspath.join(CP_SEP),
    classpath_separator: CP_SEP,
    library_directory: P.libraries,
    quickPlayMultiplayer: server || '',
  };

  const jvm = [];
  jvm.push('-Xmx' + memory + 'M');
  jvm.push('-Xms' + Math.min(memory, Math.max(512, Math.floor(memory / 2))) + 'M');
  jvm.push('-Djava.net.preferIPv4Stack=true');
  jvm.push('-Dfml.ignoreInvalidMinecraftCertificates=true');
  jvm.push('-Dfml.ignorePatchDiscrepancies=true');
  jvm.push('-Dminecraft.launcher.brand=' + LAUNCHER_NAME);
  jvm.push('-Dminecraft.launcher.version=' + LAUNCHER_VERSION);
  if (process.platform === 'darwin') jvm.push('-XstartOnFirstThread');

  // Конфиг log4j: и корректные логи, и защита от log4shell на старых версиях
  if (version.logging && version.logging.client && version.logging.client.file) {
    const cfg = path.join(P.assets, 'log_configs', version.logging.client.file.id);
    if (fs.existsSync(cfg)) {
      const arg = version.logging.client.argument || '-Dlog4j.configurationFile=${path}';
      jvm.push(R.substitute(arg, { path: cfg }));
    }
  }

  const extras = String(settings.jvmArgs || '').split(/\s+/).filter(Boolean);
  // Частая ошибка при копировании «флагов Aikar»: экспериментальные опции без разблокировки.
  // JVM в этом случае не стартует вообще, поэтому дописываем ключ сами и строго перед ними.
  if (extras.some((a) => EXPERIMENTAL_VM_OPTIONS.test(a)) && !extras.includes(UNLOCK_EXPERIMENTAL)) {
    jvm.push(UNLOCK_EXPERIMENTAL);
  }
  for (const extra of extras) jvm.push(extra);

  if (version.arguments && version.arguments.jvm) {
    jvm.push(...R.flattenArguments(version.arguments.jvm, vars, features));
  } else {
    jvm.push('-Djava.library.path=' + nativesDir);
    jvm.push('-cp', vars.classpath);
  }

  let game = [];
  if (version.arguments && version.arguments.game) {
    game = R.flattenArguments(version.arguments.game, vars, features);
  } else if (version.minecraftArguments) {
    game = version.minecraftArguments.split(/\s+/).filter(Boolean).map((a) => R.substitute(a, vars));
    if (features.has_custom_resolution) {
      game.push('--width', vars.resolution_width, '--height', vars.resolution_height);
    }
  }

  if (settings.fullscreen && !game.includes('--fullscreen')) game.push('--fullscreen');

  // Версии до 1.20 не знают quickPlay — там подключение задаётся парой --server/--port
  if (server && !game.includes('--quickPlayMultiplayer')) {
    const [host, port] = String(server).split(':');
    game.push('--server', host);
    if (port) game.push('--port', port);
  }

  const args = [...jvm, version.mainClass, ...game];
  return { args, vars, features };
}

/** Отсекает токен из строки лога, чтобы он не попал в файл или UI. */
function sanitize(line, account) {
  let out = String(line);
  if (account && account.accessToken && account.accessToken.length > 8) {
    out = out.split(account.accessToken).join('<token>');
  }
  return out.replace(/(--accessToken\s+)\S+/g, '$1<token>');
}

/**
 * Полный цикл: установка версии -> подбор Java -> запуск процесса.
 * onEvent получает события прогресса, логов и завершения.
 */
async function launchInstance(instance, account, settings, onEvent, options) {
  const emit = (type, payload) => {
    try { onEvent({ type, instanceId: instance.id, ...payload }); } catch { /* окно закрыто */ }
  };

  if (running.has(instance.id)) throw new Error('Эта сборка уже запущена');
  if (!account) throw new Error('Сначала добавьте аккаунт на вкладке «Аккаунты»');

  const versionId = instance.versionId;
  emit('progress', { stage: 'start', label: 'Проверка файлов', done: 0, total: 1 });

  const installed = await installVersion(versionId, (p) => emit('progress', p), settings);
  const version = installed.version;

  const javaInfo = await javaMod.resolveJava(version, settings, (p) => emit('progress', p));
  if (javaInfo.major < javaMod.requiredMajor(version)) {
    throw new Error('Для ' + versionId + ' нужна Java ' + javaMod.requiredMajor(version) +
      ', а выбрана Java ' + javaInfo.major + '. Измените путь в настройках.');
  }

  const gameDir = instance.isolated === false ? P.root : P.instanceDir(instance.id);
  fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(gameDir, 'config'), { recursive: true });

  const effective = { ...settings, ...(instance.overrides || {}) };
  const { args } = buildCommand({
    version,
    classpath: installed.classpath,
    nativesDir: installed.nativesDir,
    jarPath: installed.jarPath,
    gameDir,
    account,
    settings: effective,
    javaInfo,
    server: (options && options.server) || null,
  });

  const javaBin = javaMod.silentBinary(javaInfo.path);
  emit('progress', { stage: 'launch', label: 'Запуск Minecraft', done: 1, total: 1 });

  const logFile = path.join(P.logs, instance.id + '.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'w' });
  logStream.on('error', () => {});
  logStream.write('> ' + javaBin + '\n> Java ' + javaInfo.major + ' | версия ' + version.id + '\n\n');

  const child = spawn(javaBin, args, {
    cwd: gameDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state = { child, startedAt: Date.now(), tail: [], logFile };
  running.set(instance.id, state);

  const onChunk = (buf) => {
    const text = sanitize(buf.toString('utf8'), account);
    logStream.write(text);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      state.tail.push(line);
      if (state.tail.length > 400) state.tail.shift();
      emit('log', { line });
    }
  };
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  child.on('error', (err) => {
    running.delete(instance.id);
    logStream.end();
    emit('exit', { code: -1, error: 'Не удалось запустить Java: ' + err.message, logFile });
  });

  child.on('close', (code) => {
    running.delete(instance.id);
    logStream.end();
    const seconds = Math.round((Date.now() - state.startedAt) / 1000);
    let error = null;
    // Принудительная остановка пользователем всегда даёт ненулевой код — это не сбой игры
    if (code !== 0 && !state.stopping) {
      const hint = diagnose(state.tail, code);
      error = 'Игра завершилась с кодом ' + code + (hint ? '. ' + hint : '');
    }
    emit('exit', { code, error, seconds, logFile, stopped: Boolean(state.stopping), tail: state.tail.slice(-40) });
  });

  emit('started', { pid: child.pid, versionId: version.id, java: javaInfo.major, logFile });
  return { pid: child.pid, versionId: version.id, java: javaInfo.major, logFile };
}

/** Превращает типовые падения в понятную подсказку вместо голого кода выхода. */
function diagnose(tail, code) {
  const text = tail.join('\n');
  // Битые аргументы JVM — процесс падает мгновенно, без единой строки от самой игры
  if (/Unrecognized VM option|Unrecognized option|is experimental and must be enabled/i.test(text)) {
    const bad = /option '([^']+)'/i.exec(text);
    return 'Некорректный аргумент JVM' + (bad ? ' — ' + bad[1] : '') +
      '. Откройте Настройки → Аргументы JVM и исправьте или очистите поле';
  }
  if (/Could not create the Java Virtual Machine/i.test(text)) {
    return 'JVM не запустилась — проверьте аргументы JVM и объём выделенной памяти в настройках';
  }
  if (/OutOfMemoryError|Could not reserve enough space/i.test(text)) {
    return 'Не хватило памяти — уменьшите выделенную RAM или закройте другие программы';
  }
  if (/UnsupportedClassVersionError/i.test(text)) {
    return 'Несовместимая версия Java для этой сборки';
  }
  // Только реальные отказы графики: простое упоминание OpenGL встречается в обычных логах
  if (/Pixel format not accelerated|Failed to create window|GLFW error|Couldn't create GL context|no OpenGL context|OpenGL 3\.2|GLFW_[A-Z_]*ERROR/i.test(text)) {
    return 'Проблема с видеодрайвером — обновите драйверы GPU';
  }
  if (/Missing or unsupported mandatory dependencies|Mod .* requires/i.test(text)) {
    return 'Конфликт модов: не хватает зависимостей — проверьте вкладку «Моды»';
  }
  if (/java\.lang\.NoClassDefFoundError|ClassNotFoundException/i.test(text)) {
    return 'Повреждены библиотеки — переустановите версию';
  }
  if (code === 1) return 'Смотрите лог для подробностей';
  return '';
}

function stop(instanceId) {
  const state = running.get(instanceId);
  if (!state) return false;
  state.stopping = true;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(state.child.pid), '/f', '/t'], { windowsHide: true });
    } else {
      state.child.kill('SIGTERM');
    }
  } catch {
    return false;
  }
  return true;
}

function isRunning(instanceId) { return running.has(instanceId); }
function runningIds() { return [...running.keys()]; }

module.exports = { launchInstance, buildCommand, stop, isRunning, runningIds };
