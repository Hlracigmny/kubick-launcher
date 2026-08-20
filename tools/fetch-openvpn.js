'use strict';
/**
 * Кладёт свою копию OpenVPN в resources/openvpn, чтобы она попала в установщик.
 *
 * Скрипт ничего не решает за владельца проекта: он только скачивает то, что
 * указано в CONFIG ниже, проверяет контрольную сумму и распаковывает. Версия
 * и контрольная сумма задаются руками — сознательно. Автоматически тянуть
 * «последнюю» версию чужого исполняемого файла и класть её в свой установщик
 * нельзя: что именно поедет пользователям, должно быть известно заранее.
 *
 * Запуск:
 *   node tools/fetch-openvpn.js
 *
 * Перед первым запуском заполните CONFIG. Где взять значения:
 *   1. openvpn.net/community-downloads — скачайте установщик для Windows x64;
 *   2. там же опубликованы контрольные суммы, возьмите SHA256;
 *   3. впишите версию, ссылку и сумму сюда.
 *
 * Почему не «просто скачать»: без сверки суммы вы кладёте в свой установщик
 * то, что вернула сеть, и подписываете это своим именем.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CONFIG = {
  // Пример заполнения (значения нужно проверить и заменить на актуальные):
  // version: '2.6.12',
  // url: 'https://swupdate.openvpn.org/community/releases/OpenVPN-2.6.12-I001-amd64.msi',
  // sha256: '...',
  version: null,
  url: null,
  sha256: null,
};

const TARGET = path.join(__dirname, '..', 'resources', 'openvpn');
const CACHE = path.join(__dirname, '..', 'resources', '.cache');

/** Файлы, которые реально нужны рядом с openvpn.exe. */
const WANTED = [/^openvpn\.exe$/i, /\.dll$/i, /^tap-windows.*\.(exe|msi)$/i, /^COPYING$/i, /^license\.txt$/i];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const get = (target, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Слишком много перенаправлений'));
      https.get(target, { headers: { 'User-Agent': 'KubickLauncher' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, target).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ' — ' + target));
        }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        res.on('data', (c) => {
          got += c.length;
          if (total) process.stdout.write('\r  загрузка: ' + Math.round((got / total) * 100) + '%   ');
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => { process.stdout.write('\n'); resolve(dest); }));
      }).on('error', reject);
    };
    get(url);
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** Распаковывает msi через msiexec: администратор для этого не нужен. */
function extractMsi(msi, into) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(into, { recursive: true });
    execFile('msiexec', ['/a', msi, '/qn', 'TARGETDIR=' + into], (err) => {
      if (err) reject(new Error('msiexec не смог распаковать пакет: ' + err.message));
      else resolve(into);
    });
  });
}

/** Собирает нужные файлы из распакованного дерева в одну папку. */
function collect(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let copied = 0;
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!WANTED.some((re) => re.test(entry.name))) continue;
      fs.copyFileSync(full, path.join(to, entry.name));
      copied++;
    }
  };
  walk(from);
  return copied;
}

(async () => {
  if (!CONFIG.url || !CONFIG.sha256) {
    console.log('CONFIG в этом файле не заполнен — скрипт ничего не делает.\n');
    console.log('Что нужно сделать:');
    console.log('  1. Откройте https://openvpn.net/community-downloads/');
    console.log('  2. Возьмите ссылку на установщик для Windows x64 и его SHA256');
    console.log('  3. Впишите version, url и sha256 в начало tools/fetch-openvpn.js');
    console.log('  4. Запустите скрипт снова\n');
    console.log('Вариант без скрипта: распакуйте установщик вручную и скопируйте');
    console.log('содержимое bin в resources/openvpn — этого достаточно.');
    console.log('\nПодробности и про лицензию — в resources/openvpn/README.md');
    process.exit(0);
  }

  const archive = path.join(CACHE, path.basename(new URL(CONFIG.url).pathname));
  console.log('OpenVPN ' + CONFIG.version);

  if (!fs.existsSync(archive)) {
    console.log('  источник: ' + CONFIG.url);
    await download(CONFIG.url, archive);
  } else {
    console.log('  файл уже скачан, проверяем сумму');
  }

  const actual = await sha256(archive);
  if (actual !== String(CONFIG.sha256).toLowerCase()) {
    fs.rmSync(archive, { force: true });
    console.error('  СУММА НЕ СОВПАЛА');
    console.error('  ожидали: ' + CONFIG.sha256);
    console.error('  получили: ' + actual);
    console.error('\nФайл удалён. Либо в CONFIG устаревшая сумма, либо скачалось не то —');
    console.error('в установщик такое класть нельзя.');
    process.exit(1);
  }
  console.log('  контрольная сумма совпала');

  const unpacked = path.join(CACHE, 'unpacked');
  fs.rmSync(unpacked, { recursive: true, force: true });
  await extractMsi(archive, unpacked);

  fs.rmSync(TARGET, { recursive: true, force: true });
  const copied = collect(unpacked, TARGET);
  fs.rmSync(unpacked, { recursive: true, force: true });

  if (!fs.existsSync(path.join(TARGET, 'openvpn.exe'))) {
    console.error('\nopenvpn.exe в распакованном пакете не нашёлся — проверьте, тот ли файл скачан.');
    process.exit(1);
  }

  console.log('  скопировано файлов: ' + copied);
  console.log('\nГотово. Файлы в resources/openvpn — они попадут в установщик.');
  console.log('Не забудьте про GPLv2: рядом должен лежать COPYING и ссылка на исходники.');
})().catch((e) => { console.error('Сбой:', e.message); process.exit(1); });
