'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const { nativeImage } = require('electron');
const P = require('./paths');
const nbt = require('./nbt');
const { resolveVersion } = require('./mc/install');

/**
 * Чтение того, что реально лежит в папке сборки: моды с их описаниями,
 * миры из level.dat, ресурспаки из pack.mcmeta, скриншоты, логи.
 *
 * Всё берётся из файлов игры, а не из наших записей — если игрок положил мод
 * руками или удалил мир, лаунчер это увидит.
 */

function dirOf(instanceId, sub) {
  return sub ? path.join(P.instanceDir(instanceId), sub) : P.instanceDir(instanceId);
}

function listFiles(dir, filter) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && (!filter || filter(e.name)))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function statSafe(file) {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtime: st.mtimeMs };
  } catch {
    return { size: 0, mtime: 0 };
  }
}

/** Уменьшает картинку до иконки — полноразмерные PNG в интерфейсе не нужны. */
function thumbnail(buffer, width) {
  try {
    let image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return null;
    const size = image.getSize();
    if (size.width > width) image = image.resize({ width, quality: 'good' });
    return image.toDataURL();
  } catch {
    return null;
  }
}

/* --------------------------------- Моды ---------------------------------- */

function readZipText(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) return null;
  try { return entry.getData().toString('utf8'); } catch { return null; }
}

function readZipBuffer(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) return null;
  try { return entry.getData(); } catch { return null; }
}

/** mods.toml — маленький кусочек TOML, полноценный парсер тут излишен. */
function parseModsToml(text) {
  const block = text.split(/\[\[mods\]\]/)[1];
  if (!block) return null;
  const pick = (key) => {
    const m = new RegExp(key + '\\s*=\\s*(?:"""([\\s\\S]*?)"""|"([^"]*)"|\'([^\']*)\')').exec(block);
    return m ? (m[1] || m[2] || m[3] || '').trim() : '';
  };
  const id = pick('modId');
  if (!id) return null;
  return {
    id,
    name: pick('displayName') || id,
    version: pick('version'),
    description: pick('description'),
    authors: pick('authors'),
    logo: pick('logoFile'),
  };
}

function manifestVersion(zip) {
  const text = readZipText(zip, 'META-INF/MANIFEST.MF');
  if (!text) return '';
  const m = /Implementation-Version:\s*(\S+)/.exec(text);
  return m ? m[1] : '';
}

/** Достаёт из jar то, что мод сам о себе сообщает. */
function readModMeta(file) {
  let zip;
  try { zip = new AdmZip(file); } catch { return null; }

  // Fabric и Quilt
  for (const name of ['fabric.mod.json', 'quilt.mod.json']) {
    const text = readZipText(zip, name);
    if (!text) continue;
    try {
      const json = JSON.parse(text);
      const meta = name === 'quilt.mod.json' ? (json.quilt_loader || {}) : json;
      const md = meta.metadata || {};
      const authors = json.authors || md.contributors;
      return {
        loader: name === 'quilt.mod.json' ? 'Quilt' : 'Fabric',
        id: meta.id || json.id,
        name: md.name || json.name || meta.id || json.id,
        version: meta.version || json.version || '',
        description: md.description || json.description || '',
        authors: Array.isArray(authors)
          ? authors.map((a) => (typeof a === 'string' ? a : a.name)).filter(Boolean).join(', ')
          : (typeof authors === 'object' ? Object.keys(authors).join(', ') : String(authors || '')),
        icon: iconFromZip(zip, md.icon || json.icon),
      };
    } catch {
      // повреждённый json — попробуем другие форматы
    }
  }

  // Forge и NeoForge, 1.13 и новее
  const toml = readZipText(zip, 'META-INF/mods.toml') || readZipText(zip, 'META-INF/neoforge.mods.toml');
  if (toml) {
    const meta = parseModsToml(toml);
    if (meta) {
      let version = meta.version;
      if (!version || /\$\{/.test(version)) version = manifestVersion(zip) || version;
      return {
        loader: readZipText(zip, 'META-INF/neoforge.mods.toml') ? 'NeoForge' : 'Forge',
        id: meta.id,
        name: meta.name,
        version: version || '',
        description: meta.description,
        authors: meta.authors,
        icon: iconFromZip(zip, meta.logo),
      };
    }
  }

  // Forge до 1.13
  const legacy = readZipText(zip, 'mcmod.info');
  if (legacy) {
    try {
      const arr = JSON.parse(legacy);
      const m = Array.isArray(arr) ? arr[0] : (arr.modList || [])[0];
      if (m) {
        return {
          loader: 'Forge',
          id: m.modid,
          name: m.name || m.modid,
          version: m.version || '',
          description: m.description || '',
          authors: (m.authorList || m.authors || []).join(', '),
          icon: iconFromZip(zip, m.logoFile),
        };
      }
    } catch {
      // не разобрали — покажем просто имя файла
    }
  }
  return null;
}

function iconFromZip(zip, name) {
  if (!name) return null;
  const buf = readZipBuffer(zip, String(name).replace(/^\//, ''));
  if (!buf) return null;
  return thumbnail(buf, 64);
}

function mods(instanceId) {
  const dir = dirOf(instanceId, 'mods');
  const files = listFiles(dir, (n) => /\.jar(\.disabled)?$/i.test(n));

  return files.map((filename) => {
    const full = path.join(dir, filename);
    const { size, mtime } = statSafe(full);
    const enabled = !filename.endsWith('.disabled');
    const meta = readModMeta(full) || {};
    return {
      filename,
      path: full,
      enabled,
      size,
      mtime,
      name: meta.name || filename.replace(/\.jar(\.disabled)?$/i, ''),
      version: meta.version || '',
      description: meta.description || '',
      authors: meta.authors || '',
      loader: meta.loader || '',
      modId: meta.id || '',
      icon: meta.icon || null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/* ---------------------------- Наборы ресурсов ---------------------------- */

function readPackMeta(file) {
  const isZip = /\.zip$/i.test(file);
  try {
    if (isZip) {
      const zip = new AdmZip(file);
      const text = readZipText(zip, 'pack.mcmeta');
      const icon = readZipBuffer(zip, 'pack.png');
      return { text, icon: icon ? thumbnail(icon, 64) : null };
    }
    const text = fs.readFileSync(path.join(file, 'pack.mcmeta'), 'utf8');
    let icon = null;
    try { icon = thumbnail(fs.readFileSync(path.join(file, 'pack.png')), 64); } catch { /* без иконки */ }
    return { text, icon };
  } catch {
    return { text: null, icon: null };
  }
}

function packs(instanceId, sub) {
  const dir = dirOf(instanceId, sub);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  const out = [];
  for (const entry of entries) {
    const isZip = entry.isFile() && /\.(zip|jar)$/i.test(entry.name);
    if (!isZip && !entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    const { size, mtime } = statSafe(full);

    const meta = readPackMeta(full);
    let description = '';
    let format = null;
    if (meta.text) {
      try {
        const json = JSON.parse(meta.text.replace(/^﻿/, ''));
        const pack = json.pack || {};
        description = typeof pack.description === 'string'
          ? pack.description
          : JSON.stringify(pack.description || '');
        format = pack.pack_format != null ? pack.pack_format : null;
      } catch { /* битый pack.mcmeta */ }
    }

    out.push({
      filename: entry.name,
      path: full,
      folder: entry.isDirectory(),
      size,
      mtime,
      name: entry.name.replace(/\.(zip|jar)$/i, ''),
      description: String(description).replace(/§[0-9a-fk-or]/gi, '').slice(0, 160),
      format,
      icon: meta.icon,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/* --------------------------------- Миры ---------------------------------- */

const GAME_MODE = { 0: 'Выживание', 1: 'Творческий', 2: 'Приключение', 3: 'Наблюдатель' };

function folderSize(dir) {
  let total = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else total += statSafe(full).size;
    }
  };
  walk(dir);
  return total;
}

function worlds(instanceId) {
  const dir = dirOf(instanceId, 'saves');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    const world = {
      folder: entry.name,
      path: full,
      name: entry.name,
      lastPlayed: 0,
      mode: '',
      hardcore: false,
      version: '',
      size: folderSize(full),
      icon: null,
    };

    // level.dat — сжатый gzip NBT
    try {
      const raw = fs.readFileSync(path.join(full, 'level.dat'));
      const data = nbt.read(zlib.gunzipSync(raw));
      const lvl = (data.value.Data && data.value.Data.value) || {};
      if (lvl.LevelName) world.name = lvl.LevelName.value;
      if (lvl.LastPlayed) world.lastPlayed = Number(lvl.LastPlayed.value);
      if (lvl.GameType) world.mode = GAME_MODE[lvl.GameType.value] || '';
      if (lvl.hardcore) world.hardcore = Boolean(lvl.hardcore.value);
      if (lvl.Version && lvl.Version.value && lvl.Version.value.Name) {
        world.version = lvl.Version.value.Name.value;
      }
    } catch { /* мир без level.dat или повреждён — покажем по имени папки */ }

    try { world.icon = thumbnail(fs.readFileSync(path.join(full, 'icon.png')), 96); } catch { /* нет превью */ }
    out.push(world);
  }
  return out.sort((a, b) => b.lastPlayed - a.lastPlayed);
}

/* ------------------------------ Скриншоты -------------------------------- */

function screenshots(instanceId) {
  const dir = dirOf(instanceId, 'screenshots');
  return listFiles(dir, (n) => /\.(png|jpg|jpeg)$/i.test(n))
    .map((filename) => {
      const full = path.join(dir, filename);
      const { size, mtime } = statSafe(full);
      let preview = null;
      try { preview = thumbnail(fs.readFileSync(full), 320); } catch { /* битый файл */ }
      return { filename, path: full, size, mtime, preview };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/* -------------------------------- Журналы -------------------------------- */

function logFiles(instanceId) {
  const out = [];
  for (const sub of ['logs', 'crash-reports']) {
    const dir = dirOf(instanceId, sub);
    for (const filename of listFiles(dir, (n) => /\.(log|txt|gz)$/i.test(n))) {
      const full = path.join(dir, filename);
      const { size, mtime } = statSafe(full);
      out.push({ filename, path: full, size, mtime, kind: sub });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function readLog(file) {
  try {
    if (/\.gz$/i.test(file)) return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').slice(-400000);
    const text = fs.readFileSync(file, 'utf8');
    return text.length > 400000 ? text.slice(-400000) : text;
  } catch (e) {
    throw new Error('Не удалось прочитать журнал: ' + e.message);
  }
}

/* -------------------------------- Заметки -------------------------------- */

function notesFile(instanceId) {
  return path.join(P.instanceDir(instanceId), 'kubick-notes.txt');
}

function getNotes(instanceId) {
  try { return fs.readFileSync(notesFile(instanceId), 'utf8'); } catch { return ''; }
}

function setNotes(instanceId, text) {
  fs.mkdirSync(P.instanceDir(instanceId), { recursive: true });
  fs.writeFileSync(notesFile(instanceId), String(text || ''), 'utf8');
  return true;
}

/* ------------------------------ Компоненты ------------------------------- */

/** Из чего собрана версия: Minecraft, загрузчик, LWJGL, требуемая Java. */
async function components(instanceId, instance) {
  const version = await resolveVersion(instance.versionId);
  const list = [];

  list.push({ id: 'minecraft', name: 'Minecraft', version: instance.mcVersion, required: true });

  const lwjgl = (version.libraries || []).find((l) => /^org\.lwjgl:lwjgl:/.test(l.name || ''));
  if (lwjgl) {
    list.push({ id: 'lwjgl', name: 'LWJGL', version: String(lwjgl.name).split(':')[2], required: true });
  }

  if (instance.loader && instance.loader !== 'vanilla') {
    const LABEL = { fabric: 'Fabric Loader', quilt: 'Quilt Loader', forge: 'Forge', neoforge: 'NeoForge' };
    list.push({
      id: instance.loader,
      name: LABEL[instance.loader] || instance.loader,
      version: instance.loaderVersion || '—',
      required: true,
    });
  }

  const intermediary = (version.libraries || []).find((l) => /intermediary/i.test(l.name || ''));
  if (intermediary) {
    list.push({ id: 'intermediary', name: 'Intermediary Mappings', version: String(intermediary.name).split(':')[2], required: false });
  }

  list.push({
    id: 'java',
    name: 'Java',
    version: String((version.javaVersion && version.javaVersion.majorVersion) || '—'),
    required: true,
  });

  return {
    versionId: version.id,
    mainClass: version.mainClass,
    assetIndex: (version.assetIndex && version.assetIndex.id) || '',
    libraries: (version.libraries || []).length,
    components: list,
  };
}

module.exports = {
  mods, packs, worlds, screenshots, logFiles, readLog,
  getNotes, setNotes, components, dirOf,
};
