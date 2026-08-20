'use strict';
/**
 * Проверка отбора библиотек на настоящем манифесте Mojang.
 *
 * Ловит ту самую поломку, из-за которой 26.2 падала с
 * «UnsatisfiedLinkError: Failed to locate library: lwjgl.dll»:
 * начиная с 1.19 нативы приезжают обычными jar и должны лежать в classpath,
 * иначе LWJGL их не находит.
 *
 * Запуск: node tools/natives-test.js [версия]
 */
const https = require('https');
const path = require('path');

const { collectLibraries } = require('../src/main/mc/install.js');
const R = require('../src/main/mc/rules.js');

const get = (url) => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': 'KubickLauncher-test' } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve(data));
  }).on('error', reject);
});

const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);

(async () => {
  const manifest = JSON.parse(await get('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'));
  const wanted = process.argv[2] || manifest.latest.release;
  const entry = manifest.versions.find((v) => v.id === wanted);
  if (!entry) throw new Error('Версия не найдена в манифесте: ' + wanted);

  const version = JSON.parse(await get(entry.url));
  console.log('Версия ' + version.id + ' (' + version.type + '), библиотек в манифесте: ' + (version.libraries || []).length);

  const collected = collectLibraries(version);
  const cpNames = collected.classpath.map((p) => path.basename(p));
  const natNames = collected.natives.map((n) => n.name);

  /* Пустой список нативов означает, что игра не стартует вообще.
     Так ломались 1.13–1.18: дедупликация выбрасывала натив, приняв его за дубль классов. */
  check('нативы вообще собраны', collected.natives.length > 0, 'список пуст');

  /* Отбор по архитектуре: на x64 не должно быть ни x86, ни arm64, ни чужих ОС */
  const foreign = natNames.filter((n) => !R.nativeFitsHost(n));
  check('нативы отобраны под эту машину', foreign.length === 0, foreign.join(', '));

  if (R.OS_NAME === 'windows' && R.OS_ARCH === 'x64') {
    check('32-битные нативы отброшены',
      !natNames.some((n) => n.endsWith(':natives-windows-x86')), natNames.filter((n) => n.includes('x86')).join(', '));
    check('arm64-нативы отброшены',
      !natNames.some((n) => n.endsWith(':natives-windows-arm64')), '');
    check('нативы для linux и macos отброшены',
      !natNames.some((n) => /natives-(linux|macos)/.test(n)), '');
  }

  /* Главное: натив LWJGL обязан быть и в списке нативов, и в classpath.
     У LWJGL 2 (до 1.19) это org.lwjgl.lwjgl:lwjgl-platform со старым полем natives,
     у LWJGL 3 — обычный jar с классификатором natives-windows в имени. */
  const lwjglNative = collected.natives.find((n) => /lwjgl/i.test(n.name));
  check('натив LWJGL найден среди нативов', Boolean(lwjglNative), natNames.slice(0, 3).join(', '));

  if (lwjglNative) {
    check('натив LWJGL попал в classpath', collected.classpath.includes(lwjglNative.dest),
      'нет ' + path.basename(lwjglNative.dest));
  }

  /* Новый формат: натив должен ехать обычным jar, без старого поля natives */
  const modern = (version.libraries || []).some((l) => !l.natives && /:natives-/.test(l.name || ''));
  if (modern) {
    check('нативы нового формата разобраны',
      collected.natives.some((n) => /:natives-/.test(n.name)), 'ни одного не распознали');
  }

  const nativeJarsInCp = collected.natives.filter((n) => collected.classpath.includes(n.dest));
  check('все нативы попали в classpath',
    nativeJarsInCp.length === collected.natives.length,
    nativeJarsInCp.length + ' из ' + collected.natives.length);

  check('в classpath нет повторов',
    new Set(collected.classpath).size === collected.classpath.length,
    collected.classpath.length - new Set(collected.classpath).size + ' повторов');

  /* Аргументы JVM версии: понимаем ли мы, куда она ждёт подпапки */
  const jvmArgs = JSON.stringify((version.arguments && version.arguments.jvm) || []);
  const usesScratch = jvmArgs.includes('${natives_directory}/');
  console.log('версия использует подпапки в ${natives_directory}: ' + (usesScratch ? 'да' : 'нет'));
  if (usesScratch) {
    const subs = [...jvmArgs.matchAll(/\$\{natives_directory\}\/([a-z]+)/g)].map((m) => m[1]);
    const known = ['java', 'jna', 'lwjgl', 'netty'];
    const missing = [...new Set(subs)].filter((s) => !known.includes(s));
    check('все нужные подпапки нативов известны лаунчеру', missing.length === 0,
      'не создаём: ' + missing.join(', '));
  }

  let failed = 0;
  for (const [name, ok, detail] of results) {
    if (!ok) failed++;
    console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok || !detail ? '' : '  -> ' + detail));
  }
  console.log(failed ? '\n' + failed + ' проверок не прошло' : '\nВсе проверки прошли');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('СБОЙ ПРОВЕРКИ:', e.message); process.exit(1); });
