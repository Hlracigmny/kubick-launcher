'use strict';
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const { fetchJson, downloadFile } = require('../net');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const CACHE = path.join(P.cache, 'version_manifest_v2.json');
const TTL_MS = 30 * 60 * 1000;

let memory = null;
let memoryAt = 0;

async function getManifest(force = false) {
  const now = Date.now();
  if (!force && memory && now - memoryAt < TTL_MS) return memory;
  try {
    const data = await fetchJson(MANIFEST_URL, { attempts: 3 });
    if (!data || !Array.isArray(data.versions)) throw new Error('Пустой манифест версий');
    fs.mkdirSync(P.cache, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(data), 'utf8');
    memory = data; memoryAt = now;
    return data;
  } catch (e) {
    // Оффлайн — работаем на кеше, чтобы уже установленные версии оставались запускаемыми
    if (fs.existsSync(CACHE)) {
      memory = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      memoryAt = now;
      return memory;
    }
    throw new Error('Не удалось получить список версий Minecraft: ' + e.message);
  }
}

async function listVersions({ snapshots = false } = {}) {
  const m = await getManifest();
  return m.versions
    .filter((v) => snapshots || v.type === 'release')
    .map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime, url: v.url, sha1: v.sha1 }));
}

async function latest() {
  const m = await getManifest();
  return m.latest || { release: null, snapshot: null };
}

/** Скачивает и кеширует официальный version.json на диск. */
async function ensureVanillaJson(id) {
  const dest = P.versionJson(id);
  if (fs.existsSync(dest)) {
    try { return JSON.parse(fs.readFileSync(dest, 'utf8')); } catch { /* перекачаем */ }
  }
  const m = await getManifest();
  const entry = m.versions.find((v) => v.id === id);
  if (!entry) throw new Error('Версия Minecraft не найдена: ' + id);
  await downloadFile(entry.url, dest, { sha1: entry.sha1 });
  return JSON.parse(fs.readFileSync(dest, 'utf8'));
}

module.exports = { getManifest, listVersions, latest, ensureVanillaJson, MANIFEST_URL };
