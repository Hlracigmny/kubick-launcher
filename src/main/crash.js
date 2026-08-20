'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./paths');

/**
 * Журнал падений игры и разбор причин.
 *
 * Зачем отдельно от обычного лога. `logs/<instance>.log` перезаписывается при
 * каждом запуске: упало вчера, запустил сегодня — разбираться уже не в чем.
 * Поэтому каждое ненулевое завершение сохраняется отдельной записью и живёт,
 * пока её не вытеснят новые.
 *
 * Источников два, и они дополняют друг друга:
 *   - наш перехват stdout/stderr — виден и до того, как игра успела запуститься
 *     (битые аргументы JVM, не найденная библиотека, нехватка памяти под кучу);
 *   - `crash-reports/*.txt`, который пишет сама игра — там разложено по полочкам
 *     железо, моды и стек, но только если JVM дожила до своего обработчика.
 */

const KEEP_PER_INSTANCE = 20;

/* --------------------------- Разбор причины --------------------------- */

/**
 * Таблица причин. Каждая запись отвечает на три вопроса: что случилось,
 * почему и что делать. Порядок важен — выигрывает первое совпадение,
 * поэтому конкретные правила стоят выше общих.
 *
 * `code` проверяется по коду выхода процесса, `test` — по тексту логов.
 */
const RULES = [
  {
    id: 'natives',
    test: /Failed to locate library|UnsatisfiedLinkError|no lwjgl in java\.library\.path|Failed to load a library/i,
    title: 'Не найдены нативные библиотеки',
    why: 'Игре не хватает lwjgl.dll и соседних файлов: они либо не распаковались, либо не попали в classpath.',
    fix: 'Откройте раздел «Версия» в окне сборки и нажмите «Переустановить файлы».',
  },
  {
    id: 'java-too-new',
    test: /sun\.misc\.Unsafe|Unrecognized option: --illegal-access|--add-opens|InaccessibleObjectException|module java\.base does not|class file version 6[5-9]|class file version 7\d/i,
    title: 'Java новее, чем понимает эта версия игры',
    why: 'Старые Minecraft, Forge и часть модов используют то, что в новых JDK убрали: sun.misc.Unsafe, открытые внутренности модулей, ключ --illegal-access.',
    fix: 'Поставьте Java, которую требует эта версия игры — лаунчер умеет скачать её сам в разделе «Параметры».',
  },
  {
    id: 'java-too-old',
    test: /UnsupportedClassVersionError|has been compiled by a more recent version/i,
    title: 'Java слишком старая для этой версии игры',
    why: 'Классы собраны более новым компилятором, чем установленная Java.',
    fix: 'Обновите Java до версии, которую требует сборка — лаунчер скачает нужную сам.',
  },
  {
    id: 'jvm-args',
    test: /Unrecognized VM option|Unrecognized option|is experimental and must be enabled|Improperly specified VM option/i,
    title: 'Неверный аргумент JVM',
    why: 'JVM не поняла один из ключей запуска и завершилась, не дойдя до игры.',
    fix: 'Настройки → Аргументы JVM: исправьте ключ или очистите поле, чтобы вернуть значения по умолчанию.',
    detail: (text) => {
      const m = /option '?([^'\s]+)'?/i.exec(text);
      return m ? 'Не понравился ключ ' + m[1] : null;
    },
  },
  {
    id: 'memory',
    test: /OutOfMemoryError|Could not reserve enough space|Native memory allocation|GC overhead limit/i,
    title: 'Не хватило памяти',
    why: 'Игра запросила больше оперативной памяти, чем ей отдали или чем есть в системе.',
    fix: 'Уменьшите выделенную память в параметрах сборки либо закройте другие программы. Больше половины физической памяти отдавать игре не стоит.',
  },
  {
    id: 'jvm-start',
    test: /Could not create the Java Virtual Machine|Error occurred during initialization of VM/i,
    title: 'JVM не запустилась',
    why: 'Виртуальная машина отказалась стартовать — почти всегда из-за аргументов или запрошенного объёма памяти.',
    fix: 'Проверьте аргументы JVM и выделенную память в настройках.',
  },
  {
    id: 'mod-deps',
    test: /Missing or unsupported mandatory dependencies|requires .* which is missing|Incompatible mods found|ModResolutionException|Mod .* requires/i,
    title: 'Модам не хватает зависимостей',
    why: 'Один или несколько модов требуют библиотеки или версии, которых нет в сборке.',
    fix: 'Раздел «Моды» в окне сборки: доустановите недостающее или уберите проблемный мод. В логе перечислено, чего именно не хватает.',
  },
  {
    id: 'mod-loader-mismatch',
    test: /is not a valid mod file|does not contain a fabric\.mod\.json|Found mod file .* of type FML|Mixin apply failed|InvalidMixinException/i,
    title: 'Мод не подходит этому загрузчику',
    why: 'В папке mods лежит мод от другого загрузчика или от другой версии игры. Fabric-моды с Forge несовместимы и наоборот.',
    fix: 'Уберите лишние моды из папки mods. Если недавно меняли загрузчик — старые моды остались от прежнего.',
  },
  {
    id: 'gpu',
    test: /Pixel format not accelerated|Failed to create window|GLFW error|Couldn't create GL context|no OpenGL context|OpenGL 3\.2|GLFW_[A-Z_]*ERROR|WGL_ARB_create_context/i,
    title: 'Не удалось создать окно игры',
    why: 'Видеодрайвер не дал нужный контекст OpenGL. Обычно это устаревший драйвер или встроенная графика без поддержки нужной версии.',
    fix: 'Обновите драйверы видеокарты. На ноутбуках с двумя видеокартами убедитесь, что игра запускается на дискретной.',
  },
  {
    id: 'corrupt',
    test: /NoClassDefFoundError|ClassNotFoundException|ZipException|error in opening zip file|Invalid or corrupt jarfile/i,
    title: 'Повреждены файлы игры',
    why: 'Библиотека или jar докачались не полностью либо испортились на диске.',
    fix: 'Раздел «Версия» → «Переустановить файлы».',
  },
  {
    id: 'access-violation',
    code: -1073741819,
    title: 'Аварийное завершение в нативном коде',
    why: 'Процесс упал с нарушением доступа к памяти (0xC0000005). Чаще всего виноват видеодрайвер или мод с нативной библиотекой.',
    fix: 'Обновите драйверы видеокарты. Если не помогло — отключайте моды по половине, чтобы найти виновника.',
  },
  {
    id: 'missing-dll',
    code: -1073741515,
    title: 'В системе не хватает библиотеки',
    why: 'Процесс не смог загрузить системную DLL (0xC0000135). Обычно не установлен пакет Visual C++ Runtime.',
    fix: 'Установите Microsoft Visual C++ Redistributable (x64) и попробуйте снова.',
  },
  {
    id: 'user-closed',
    code: 143,
    title: 'Игра остановлена',
    why: 'Процесс получил сигнал завершения.',
    fix: 'Ничего делать не нужно.',
    benign: true,
  },
];

/**
 * Определяет причину по тексту логов и коду выхода.
 * Возвращает null, если ничего узнаваемого не нашлось — врать не надо.
 */
function detect(text, code) {
  const body = String(text || '');
  for (const rule of RULES) {
    const byCode = rule.code != null && rule.code === code;
    const byText = rule.test && rule.test.test(body);
    if (!byCode && !byText) continue;
    return {
      id: rule.id,
      title: rule.title,
      why: rule.why,
      fix: rule.fix,
      benign: Boolean(rule.benign),
      detail: (rule.detail && rule.detail(body)) || null,
    };
  }
  return null;
}

/** Короткая подсказка одной строкой — для тоста и статусной строки. */
function shortHint(text, code) {
  const cause = detect(text, code);
  if (!cause) return '';
  return cause.title + '. ' + cause.fix;
}

/* ------------------------ Отчёты самой игры ------------------------- */

/** Свежие crash-reports игры, появившиеся после начала запуска. */
function gameReportsSince(instanceDir, since) {
  const dir = path.join(instanceDir, 'crash-reports');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }

  const out = [];
  for (const name of names) {
    if (!/^crash-.*\.txt$/i.test(name)) continue;
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    // Запас в пять секунд: часы файловой системы и наши расходятся
    if (since && stat.mtimeMs < since - 5000) continue;
    out.push({ file, at: stat.mtimeMs, size: stat.size });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Строка Description из отчёта игры — самое короткое описание того, что случилось. */
function describeGameReport(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const description = /^Description:\s*(.+)$/m.exec(text);
  // Первая строка исключения идёт сразу за Description
  const exception = /^(?:[a-z][\w.]*\.)+[A-Z]\w*(?:Error|Exception)[^\n]*/m.exec(text);
  return {
    description: description ? description[1].trim() : null,
    exception: exception ? exception[0].trim() : null,
    text,
  };
}

/* --------------------------- Хранение записей --------------------------- */

function crashDir() {
  return path.join(P.root, 'crashes');
}

function fileFor(instanceId, at) {
  return path.join(crashDir(), instanceId + '-' + at + '.json');
}

/**
 * Сохраняет падение. Возвращает запись или null, если сохранять нечего
 * (обычная остановка пользователем падением не считается).
 */
function record({ instanceId, instanceName, versionId, java, code, tail, logFile, instanceDir, startedAt, stopped }) {
  if (stopped) return null;
  if (code === 0) return null;

  const at = Date.now();
  const ourText = (tail || []).join('\n');

  // Отчёт игры точнее нашего перехвата: там разложены и стек, и окружение
  const reports = instanceDir ? gameReportsSince(instanceDir, startedAt) : [];
  const report = reports.length ? describeGameReport(reports[0].file) : null;

  const combined = [ourText, report ? report.text : ''].join('\n');
  const cause = detect(combined, code);

  const entry = {
    instanceId,
    instanceName: instanceName || instanceId,
    versionId: versionId || null,
    java: java || null,
    code,
    at,
    playedSeconds: startedAt ? Math.round((at - startedAt) / 1000) : null,
    cause,
    description: report ? report.description : null,
    exception: report ? report.exception : null,
    gameReport: reports.length ? reports[0].file : null,
    logFile: logFile || null,
    // Хвост нужен, чтобы разобраться и без исходных файлов, если их удалят
    tail: (tail || []).slice(-80),
  };

  try {
    fs.mkdirSync(crashDir(), { recursive: true });
    fs.writeFileSync(fileFor(instanceId, at), JSON.stringify(entry, null, 2), 'utf8');
    prune(instanceId);
  } catch {
    // Не смогли записать — падение всё равно надо показать в интерфейсе
  }
  return entry;
}

/** Оставляет только последние записи по каждой сборке. */
function prune(instanceId) {
  const own = list(instanceId);
  for (const entry of own.slice(KEEP_PER_INSTANCE)) {
    try { fs.rmSync(fileFor(entry.instanceId, entry.at), { force: true }); } catch { /* уже нет */ }
  }
}

/** Записи о падениях, новые сверху. Без instanceId — по всем сборкам. */
function list(instanceId) {
  let names = [];
  try { names = fs.readdirSync(crashDir()); } catch { return []; }

  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (instanceId && !name.startsWith(instanceId + '-')) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(crashDir(), name), 'utf8'));
      if (entry && entry.at) out.push(entry);
    } catch {
      // битый файл записи не должен ломать весь список
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

function remove(instanceId, at) {
  try { fs.rmSync(fileFor(instanceId, at), { force: true }); return true; }
  catch { return false; }
}

function clear(instanceId) {
  for (const entry of list(instanceId)) remove(entry.instanceId, entry.at);
  return true;
}

module.exports = { detect, shortHint, record, list, remove, clear, gameReportsSince, describeGameReport, RULES };
