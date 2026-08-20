'use strict';
/**
 * Проверка установки сборок: свой формат .kubick, .mrpack от Modrinth
 * и архив CurseForge.
 *
 * Сеть подменена: проверяется не скачивание, а то, что после разделения
 * modpacks.install на «скачать» и «поставить» установка по-прежнему доходит
 * до конца — раскладывает моды, копирует overrides и записывает происхождение.
 *
 * Запуск: node tools/import-test.js
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);

/* --- Подменяем сеть и создание сборки ДО загрузки проверяемых модулей --- */
const netPath = require.resolve('../src/main/net.js');
require(netPath);
const downloaded = [];
require.cache[netPath].exports.downloadFile = async (url, dest) => {
  downloaded.push({ url, dest });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'файл с ' + url);
  return { skipped: false, dest };
};

const instancesPath = require.resolve('../src/main/instances.js');
require(instancesPath);
const P = require('../src/main/paths');
const { store } = require('../src/main/store');

let created = 0;
require.cache[instancesPath].exports.create = async (opts) => {
  created++;
  const id = 'inst-' + created;
  for (const sub of ['mods', 'config']) fs.mkdirSync(path.join(P.instanceDir(id), sub), { recursive: true });
  store.upsertInstance({
    id, name: opts.name, mcVersion: opts.mcVersion, loader: opts.loader,
    loaderVersion: opts.loaderVersion, versionId: opts.mcVersion, overrides: {},
  });
  return store.getInstance(id);
};
require.cache[instancesPath].exports.remove = (id) => { store.removeInstance(id); return true; };

const modpacks = require('../src/main/modpacks');
const io = require('../src/main/instance-io');

/* ------------------------------- Стенд -------------------------------- */

const work = path.join(P.root, 'packs');
fs.mkdirSync(work, { recursive: true });

function makeMrpack() {
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
    formatVersion: 1, game: 'minecraft', versionId: '1.4.2', name: 'Fabulously Optimized',
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.9' },
    files: [
      { path: 'mods/sodium.jar', hashes: { sha1: 'a' }, downloads: ['https://cdn.modrinth.com/sodium.jar'], fileSize: 100 },
      { path: 'mods/iris.jar', hashes: { sha1: 'b' }, downloads: ['https://cdn.modrinth.com/iris.jar'], fileSize: 200 },
      { path: 'mods/server.jar', env: { client: 'unsupported' }, downloads: ['https://cdn.modrinth.com/server.jar'] },
    ],
  })));
  zip.addFile('overrides/config/sodium.json', Buffer.from('{"fps":"много"}'));
  zip.addFile('overrides/options.txt', Buffer.from('fov:90'));
  const file = path.join(work, 'pack.mrpack');
  zip.writeZip(file);
  return file;
}

function makeKubick() {
  const zip = new AdmZip();
  zip.addFile('kubick.json', Buffer.from(JSON.stringify({
    format: 1, name: 'Своя сборка', mcVersion: '1.20.1', loader: 'forge',
    loaderVersion: '47.2.0', versionId: 'forge-1.20.1', overrides: { memoryMb: 6144 },
  })));
  zip.addFile('overrides/mods/mymod.jar', Buffer.from('мод'));
  zip.addFile('overrides/options.txt', Buffer.from('fov:70'));
  const file = path.join(work, 'own.kubick');
  zip.writeZip(file);
  return file;
}

function makeCurseforge() {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    name: 'RLCraft', version: '2.9.3',
    minecraft: { version: '1.12.2', modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }] },
    files: [{ projectID: 1, fileID: 2, required: true }],
    overrides: 'overrides',
  })));
  zip.addFile('overrides/config/rl.cfg', Buffer.from('x'));
  const file = path.join(work, 'rlcraft.zip');
  zip.writeZip(file);
  return file;
}

const listFiles = (dir) => {
  const out = [];
  const walk = (d, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name), prefix + e.name + '/');
      else out.push(prefix + e.name);
    }
  };
  walk(dir, '');
  return out.sort();
};

(async () => {
  /* --- Определение формата --- */
  const mrpack = makeMrpack();
  const kubick = makeKubick();
  const curse = makeCurseforge();

  check('свой формат опознан', io.detectFormat(kubick) === 'kubick', io.detectFormat(kubick));
  check('mrpack опознан', io.detectFormat(mrpack) === 'mrpack', io.detectFormat(mrpack));
  check('curseforge опознан', io.detectFormat(curse) === 'curseforge', io.detectFormat(curse));

  const junk = path.join(work, 'junk.zip');
  const jz = new AdmZip(); jz.addFile('readme.txt', Buffer.from('x')); jz.writeZip(junk);
  try { io.detectFormat(junk); check('посторонний архив отклонён', false, 'прошёл'); }
  catch (e) { check('посторонний архив отклонён', /Не удалось понять/.test(e.message), e.message); }

  /* --- Установка .mrpack --- */
  const stages = [];
  const res = await io.importInstance({ file: mrpack, name: 'Из mrpack' },
    (p) => { if (p.stage) stages.push(p.stage); }, {});

  const dir = P.instanceDir(res.instance.id);
  const files = listFiles(dir);
  check('mrpack поставился', Boolean(res.instance), JSON.stringify(res).slice(0, 80));
  check('моды скачаны', files.includes('mods/sodium.jar') && files.includes('mods/iris.jar'), JSON.stringify(files));
  check('серверный мод пропущен', !files.includes('mods/server.jar'), '');
  check('overrides разложены', files.includes('config/sodium.json') && files.includes('options.txt'), JSON.stringify(files));
  check('содержимое overrides верное', fs.readFileSync(path.join(dir, 'options.txt'), 'utf8') === 'fov:90', '');
  check('версия и загрузчик из манифеста',
    res.instance.mcVersion === '1.21.1' && res.instance.loader === 'fabric',
    res.instance.mcVersion + '/' + res.instance.loader);
  check('о прогрессе сообщалось', stages.includes('modpack'), JSON.stringify([...new Set(stages)]));

  const saved = store.getInstance(res.instance.id);
  check('происхождение помечено как файл',
    saved.modpack && saved.modpack.fromFile === true && saved.modpack.projectId === null,
    JSON.stringify(saved.modpack));
  check('выбранный файл не удалён', fs.existsSync(mrpack), '');

  /* --- Установка своего формата --- */
  const own = await io.importInstance({ file: kubick, name: 'Из kubick' }, () => {}, {});
  const ownFiles = listFiles(P.instanceDir(own.instance.id));
  check('kubick поставился', ownFiles.includes('mods/mymod.jar') && ownFiles.includes('options.txt'), JSON.stringify(ownFiles));
  check('kubick не ходил в сеть', downloaded.every((d) => !d.url.includes('mymod')), '');

  /* --- CurseForge без ключа: понятная ошибка, а не стек --- */
  try {
    await io.importInstance({ file: curse, name: 'Из curse' }, () => {}, {});
    check('CurseForge без ключа отклонён', false, 'установка прошла');
  } catch (e) {
    check('CurseForge без ключа отклонён', /API-ключ/i.test(e.message), e.message);
  }

  /* --- Прогресс установки версии: байты появились --- */
  const install = require('../src/main/mc/install');
  check('installVersion на месте', typeof install.installVersion === 'function', '');
  const src = fs.readFileSync(require.resolve('../src/main/mc/install.js'), 'utf8');
  check('в прогрессе библиотек есть байты', /libTotalBytes/.test(src), '');
  check('в прогрессе ресурсов есть байты', /totalBytes \}\);/.test(src) || /totalBytes,/.test(src), '');

  let failed = 0;
  for (const [name, ok, detail] of results) {
    if (!ok) failed++;
    console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok || !detail ? '' : '  -> ' + detail));
  }
  console.log(failed ? '\n' + failed + ' проверок не прошло' : '\nВсе проверки прошли');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('СБОЙ СТЕНДА:', e); process.exit(1); });
