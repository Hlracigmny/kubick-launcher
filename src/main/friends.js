'use strict';
const dgram = require('dgram');
const discovery = require('./netdiscovery');
const crypto = require('crypto');
const { store } = require('./store');
const lan = require('./lan');

/**
 * Друзья и их открытые миры.
 *
 * Minecraft, открывая мир для сети, кричит об этом в локальную сеть, но в его
 * сообщении нет имени игрока — только описание мира и порт. Поэтому лаунчер
 * шлёт рядом собственный маленький пакет со своим кодом и ником. Чужой лаунчер
 * ловит его, сверяет код со списком друзей и сам прописывает адрес в servers.dat —
 * друг видит сервер в игре, ничего не вводя руками.
 *
 * Работает в пределах одной сети. Для игры через интернет достаточно поднять
 * общий VPN (Radmin VPN, ZeroTier, Hamachi): для лаунчера это та же локальная сеть.
 */
const GROUP = '224.0.0.60';
const PORT = 4446;          // рядом с портом Minecraft (4445), но свой
const ANNOUNCE_MS = 3000;
const EXPIRE_MS = 12000;

let socket = null;
let announcer = null;
let sweeper = null;
let notify = () => {};
let status = { listening: false, error: null };

const online = new Map();   // код друга -> сведения о его открытом мире

/**
 * Постоянный код игрока: генерируется один раз и дальше не меняется.
 * Без аккаунта кода нет вовсе — он представляет игрока, а представлять некого:
 * друзьям он показал бы «Игрок», и они не поняли бы, кого добавили.
 * Поэтому код не выдаётся и даже не создаётся, пока аккаунт не выбран.
 */
function myCode() {
  if (!store.getActiveAccount()) return null;
  if (!store.settings.friendCode) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    store.saveSettings({ friendCode: 'KB-' + raw.slice(0, 4) + '-' + raw.slice(4) });
  }
  return store.settings.friendCode;
}

function myNick() {
  const account = store.getActiveAccount();
  return (account && account.name) || 'Игрок';
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

/* ------------------------------ Список друзей ----------------------------- */

function list() {
  const now = Date.now();
  return (store.friends.list || []).map((f) => {
    const live = online.get(f.code);
    const fresh = live && now - live.lastSeen < EXPIRE_MS;
    return {
      code: f.code,
      nick: (fresh && live.nick) || f.nick,
      addedAt: f.addedAt,
      online: Boolean(fresh),
      world: fresh ? { motd: live.motd, host: live.address + ':' + live.port } : null,
    };
  });
}

function add({ code, nick }) {
  if (!store.getActiveAccount()) {
    throw new Error('Сначала войдите в аккаунт — без него друзья не поймут, кто вы');
  }
  const clean = normalizeCode(code);
  if (!/^KB-[0-9A-F]{4}-[0-9A-F]{4}$/.test(clean)) {
    throw new Error('Код должен выглядеть так: KB-A1B2-C3D4');
  }
  if (clean === myCode()) throw new Error('Это ваш собственный код');
  if ((store.friends.list || []).some((f) => f.code === clean)) throw new Error('Этот друг уже добавлен');

  store.friends.list = [...(store.friends.list || []), {
    code: clean,
    nick: String(nick || '').trim().slice(0, 24) || 'Друг',
    addedAt: Date.now(),
  }];
  store.saveFriends();
  return list();
}

function remove(code) {
  const clean = normalizeCode(code);
  store.friends.list = (store.friends.list || []).filter((f) => f.code !== clean);
  store.saveFriends();
  online.delete(clean);
  return list();
}

function isFriend(code) {
  return (store.friends.list || []).some((f) => f.code === code);
}

function snapshot() {
  const account = store.getActiveAccount();
  return {
    ...status,
    hasAccount: Boolean(account),
    code: myCode(),
    nick: myNick(),
    friends: list(),
  };
}

function push() {
  try { notify(snapshot()); } catch { /* окно закрыто */ }
}

/* ------------------------------- Присутствие ------------------------------ */

/** Наш собственный открытый мир — берём его из того, что вещает сам Minecraft. */
function myOpenWorld() {
  const own = lan.snapshot().worlds.find((w) => w.own);
  return own || null;
}

function announce() {
  if (!socket) return;
  const code = myCode();
  if (!code) return;  // без аккаунта нам нечем представиться
  const world = myOpenWorld();
  if (!world) return; // мир не открыт — молчим, о нас нечего сообщать

  const payload = JSON.stringify({
    kubick: 1,
    code,
    nick: myNick(),
    port: world.port,
    motd: world.motd,
  });
  const buf = Buffer.from(payload, 'utf8');
  try {
    // Рассылаем и в группу, и широковещательно: в сети с фильтрацией мультикаста
    // доходит только второе, а лишний дубль друзья отбросят по коду
    for (const target of discovery.announceTargets(GROUP)) {
      try { socket.send(buf, 0, buf.length, PORT, target); } catch { /* этот адрес недоступен */ }
    }
  } catch {
    // сеть могла отвалиться — попробуем в следующий раз
  }
}

function handle(msg, rinfo) {
  let data;
  try { data = JSON.parse(msg.toString('utf8')); } catch { return; }
  if (!data || data.kubick !== 1 || !data.code || !data.port) return;

  const code = normalizeCode(data.code);
  if (code === myCode()) return;      // собственное эхо
  if (!isFriend(code)) return;        // чужих не показываем

  const before = online.get(code);
  online.set(code, {
    code,
    nick: String(data.nick || 'Друг').slice(0, 24),
    motd: String(data.motd || 'Мир друга').slice(0, 80),
    address: rinfo.address,
    port: data.port,
    lastSeen: Date.now(),
  });

  // Появился новый мир — сразу прописываем его в списки серверов
  if (!before || before.port !== data.port || before.address !== rinfo.address) {
    autoAddServers(code);
    push();
  }
}

/**
 * Прописывает мир друга в servers.dat всех сборок. Игра читает файл при запуске,
 * поэтому в уже открытой игре сервер появится после перезахода.
 */
function autoAddServers(code) {
  if (store.settings.autoAddFriendServers === false) return;
  const live = online.get(code);
  if (!live) return;

  const friend = (store.friends.list || []).find((f) => f.code === code);
  const title = (friend && friend.nick) || live.nick;
  const host = live.address + ':' + live.port;

  for (const inst of store.instances.list) {
    try {
      lan.addServer(inst.id, { name: title + ' — ' + live.motd, ip: host });
    } catch {
      // сборку могли удалить прямо сейчас
    }
  }
}

function start(onChange) {
  notify = onChange || (() => {});
  if (socket) { push(); return snapshot(); }

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('error', (err) => {
    status = { listening: false, error: 'Обмен с друзьями недоступен: ' + err.message };
    try { sock.close(); } catch { /* уже закрыт */ }
    socket = null;
    push();
  });

  sock.on('message', handle);

  sock.on('listening', () => {
    const membership = discovery.joinOnAllInterfaces(sock, GROUP);
    try { sock.setMulticastTTL(1); } catch { /* адаптер без мультикаста */ }

    // Свой протокол мы контролируем с обеих сторон, поэтому здесь есть запасной путь:
    // там, где мультикаст режется (гостевой Wi-Fi, часть роутеров), остаётся броадкаст
    let broadcast = false;
    try { sock.setBroadcast(true); broadcast = true; } catch { /* нельзя — обойдёмся */ }

    status = {
      listening: membership.joined.length > 0 || broadcast,
      error: membership.joined.length || broadcast ? null : discovery.describe(membership, false),
      multicast: membership.joined.length > 0,
      broadcast,
      note: membership.joined.length ? null : discovery.describe(membership, broadcast),
    };
    push();
  });

  try {
    sock.bind(PORT);
  } catch (e) {
    status = { listening: false, error: 'Порт ' + PORT + ' занят: ' + e.message };
    push();
    return snapshot();
  }

  socket = sock;
  announcer = setInterval(announce, ANNOUNCE_MS);
  sweeper = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [code, peer] of online) {
      if (now - peer.lastSeen >= EXPIRE_MS) { online.delete(code); changed = true; }
    }
    if (changed) push();
  }, 4000);

  return snapshot();
}

function stop() {
  if (announcer) { clearInterval(announcer); announcer = null; }
  if (sweeper) { clearInterval(sweeper); sweeper = null; }
  if (socket) {
    try { socket.dropMembership(GROUP); } catch { /* уже отвалилось */ }
    try { socket.close(); } catch { /* уже закрыт */ }
    socket = null;
  }
  online.clear();
  status = { listening: false, error: null };
}

module.exports = { start, stop, snapshot, list, add, remove, myCode, PORT };
