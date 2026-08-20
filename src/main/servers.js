'use strict';
const crypto = require('crypto');
const { pingAll } = require('./mcping');

/**
 * Подборка публичных серверов. В списке хранятся только имя, адрес и сайт —
 * всё остальное (описание, онлайн, задержка, логотип) берётся живым опросом
 * самого сервера, поэтому данные не устаревают и ничего не выдумано.
 *
 * Каждый адрес проверен опросом на момент составления списка.
 *
 * licensed — нужна ли лицензионная учётная запись Minecraft. Протокол опроса
 * такого не сообщает (online-mode виден только при попытке входа), поэтому
 * значение задано вручную по правилам самих серверов.
 */
const CATALOG = [
  { id: 'hypixel', name: 'Hypixel', address: 'mc.hypixel.net', site: 'https://hypixel.net', region: 'Мир', licensed: true },
  { id: 'funtime', name: 'FunTime', address: 'mc.funtime.su', site: 'https://funtime.su', region: 'Россия', licensed: false },
  { id: 'reallyworld', name: 'ReallyWorld', address: 'mc.reallyworld.ru', site: 'https://reallyworld.ru', region: 'Россия', licensed: false },
  { id: 'holyworld', name: 'HolyWorld', address: 'play.holyworld.ru', site: 'https://holyworld.ru', region: 'Россия', licensed: false },
  { id: 'masedworld', name: 'MasedWorld', address: 'play.masedworld.net', site: 'https://masedworld.net', region: 'Россия', licensed: false },
  { id: 'wynncraft', name: 'Wynncraft', address: 'play.wynncraft.com', site: 'https://wynncraft.com', region: 'Мир', licensed: true },
  { id: 'cubecraft', name: 'CubeCraft', address: 'play.cubecraft.net', site: 'https://cubecraft.net', region: 'Европа', licensed: true },
  { id: 'gamster', name: 'Gamster', address: 'mc.gamster.org', site: 'https://gamster.org', region: 'Европа', licensed: false },
  { id: 'mcsgg', name: 'MCS', address: 'hub.mcs.gg', site: 'https://mcs.gg', region: 'Мир', licensed: true },
  { id: 'mineland', name: 'MineLand', address: 'mc.mineland.net', site: 'https://mineland.net', region: 'Россия', licensed: false },
];

const CACHE_TTL = 60 * 1000;
let cache = null;
let cachedAt = 0;

/* --------------------------- Свои серверы ---------------------------- */

/**
 * Серверы, добавленные вручную, живут в настройках рядом с подборкой.
 * Опрашиваются они точно так же, но признак «нужна лицензия» ставит сам игрок:
 * по протоколу опроса это не определяется.
 */
function own() {
  const { store } = require('./store');
  return Array.isArray(store.settings.ownServers) ? store.settings.ownServers : [];
}

function saveOwn(next) {
  const { store } = require('./store');
  store.saveSettings({ ownServers: next });
  cache = null;   // список изменился — прошлый опрос уже неполный
  return next;
}

function addOwn({ name, address, site, licensed }) {
  const cleanAddress = String(address || '').trim();
  if (!cleanAddress) throw new Error('Укажите адрес сервера');
  if (cleanAddress.includes(' ')) throw new Error('В адресе не должно быть пробелов');

  const current = own();
  if (current.some((s) => s.address.toLowerCase() === cleanAddress.toLowerCase())) {
    throw new Error('Этот сервер уже добавлен');
  }

  const entry = {
    id: 'own-' + crypto.randomBytes(4).toString('hex'),
    name: String(name || '').trim() || cleanAddress,
    address: cleanAddress,
    site: String(site || '').trim() || null,
    region: 'Свой',
    licensed: licensed === true ? true : licensed === false ? false : null,
    own: true,
    addedAt: Date.now(),
  };
  saveOwn([...current, entry]);
  return entry;
}

function removeOwn(id) {
  saveOwn(own().filter((s) => s.id !== id));
  return true;
}

/** Подборка плюс свои: свои идут первыми — их добавляли осознанно. */
function all() {
  return [...own(), ...CATALOG];
}

function list() {
  return all().map((s) => ({ ...s }));
}

/**
 * Опрашивает все серверы разом. Результат держится минуту:
 * бегать к десяти серверам на каждое открытие раздела незачем.
 */
async function statuses({ force = false } = {}) {
  if (!force && cache && Date.now() - cachedAt < CACHE_TTL) return cache;

  const catalog = all();
  const results = await pingAll(catalog.map((s) => s.address));
  const byAddress = new Map(results.map((r) => [r.address, r]));

  cache = catalog.map((s) => {
    const live = byAddress.get(s.address) || { online: false, error: 'Нет ответа' };
    return {
      ...s,
      online: Boolean(live.online),
      latency: live.latency || 0,
      players: live.players || 0,
      maxPlayers: live.maxPlayers || 0,
      version: live.version || '',
      motd: live.motd || '',
      icon: live.favicon || null,
      error: live.error || null,
    };
  }).sort((a, b) =>
    // Свои всегда сверху, дальше живые и по числу игроков
    Number(Boolean(b.own)) - Number(Boolean(a.own)) ||
    Number(b.online) - Number(a.online) ||
    b.players - a.players);

  cachedAt = Date.now();
  return cache;
}

/** Опрос одного адреса — для серверов, добавленных вручную. */
async function pingOne(address) {
  const [result] = await pingAll([address]);
  return result;
}

module.exports = { list, statuses, pingOne, own, addOwn, removeOwn, CATALOG };
