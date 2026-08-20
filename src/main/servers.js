'use strict';
const { pingAll } = require('./mcping');

/**
 * Подборка публичных серверов. В списке хранятся только имя, адрес и сайт —
 * всё остальное (описание, онлайн, задержка, логотип) берётся живым опросом
 * самого сервера, поэтому данные не устаревают и ничего не выдумано.
 *
 * Каждый адрес проверен опросом на момент составления списка.
 */
const CATALOG = [
  { id: 'hypixel', name: 'Hypixel', address: 'mc.hypixel.net', site: 'https://hypixel.net', region: 'Мир' },
  { id: 'funtime', name: 'FunTime', address: 'mc.funtime.su', site: 'https://funtime.su', region: 'Россия' },
  { id: 'reallyworld', name: 'ReallyWorld', address: 'mc.reallyworld.ru', site: 'https://reallyworld.ru', region: 'Россия' },
  { id: 'holyworld', name: 'HolyWorld', address: 'play.holyworld.ru', site: 'https://holyworld.ru', region: 'Россия' },
  { id: 'masedworld', name: 'MasedWorld', address: 'play.masedworld.net', site: 'https://masedworld.net', region: 'Россия' },
  { id: 'wynncraft', name: 'Wynncraft', address: 'play.wynncraft.com', site: 'https://wynncraft.com', region: 'Мир' },
  { id: 'cubecraft', name: 'CubeCraft', address: 'play.cubecraft.net', site: 'https://cubecraft.net', region: 'Европа' },
  { id: 'gamster', name: 'Gamster', address: 'mc.gamster.org', site: 'https://gamster.org', region: 'Европа' },
  { id: 'mcsgg', name: 'MCS', address: 'hub.mcs.gg', site: 'https://mcs.gg', region: 'Мир' },
  { id: 'mineland', name: 'MineLand', address: 'mc.mineland.net', site: 'https://mineland.net', region: 'Россия' },
];

const CACHE_TTL = 60 * 1000;
let cache = null;
let cachedAt = 0;

function list() {
  return CATALOG.map((s) => ({ ...s }));
}

/**
 * Опрашивает все серверы разом. Результат держится минуту:
 * бегать к десяти серверам на каждое открытие раздела незачем.
 */
async function statuses({ force = false } = {}) {
  if (!force && cache && Date.now() - cachedAt < CACHE_TTL) return cache;

  const results = await pingAll(CATALOG.map((s) => s.address));
  const byAddress = new Map(results.map((r) => [r.address, r]));

  cache = CATALOG.map((s) => {
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
  }).sort((a, b) => Number(b.online) - Number(a.online) || b.players - a.players);

  cachedAt = Date.now();
  return cache;
}

/** Опрос одного адреса — для серверов, добавленных вручную. */
async function pingOne(address) {
  const [result] = await pingAll([address]);
  return result;
}

module.exports = { list, statuses, pingOne, CATALOG };
