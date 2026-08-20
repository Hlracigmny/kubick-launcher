'use strict';
const dgram = require('dgram');
const discovery = require('./netdiscovery');
const os = require('os');
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const nbt = require('./nbt');

/**
 * Minecraft при открытии мира по сети шлёт UDP-мультикаст на 224.0.0.60:4445
 * с телом вида «[MOTD]Мир игрока[/MOTD][AD]25565[/AD]». Слушая эту группу,
 * лаунчер видит миры друзей в локальной сети сразу, без ручного ввода адресов.
 */
const MULTICAST_ADDR = '224.0.0.60';
const MULTICAST_PORT = 4445;
const EXPIRE_MS = 12000;   // мир, переставший вещать, исчезает из списка
const SWEEP_MS = 3000;

let socket = null;
let sweeper = null;
let notify = () => {};
let status = { listening: false, error: null };
const peers = new Map();

/** Все IPv4-адреса машины — по ним друзья подключаются к нашему миру. */
function localAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      if (item.internal) continue;
      out.push({ iface: name, address: item.address });
    }
  }
  return out;
}

function isLocalAddress(address) {
  return localAddresses().some((a) => a.address === address);
}

/** Убирает служебные коды цвета §a, §l и т.п. */
function stripFormatting(text) {
  return String(text || '').replace(/§[0-9a-fk-orA-FK-OR]/g, '').trim();
}

function parseBroadcast(text) {
  const motd = /\[MOTD\]([\s\S]*?)\[\/MOTD\]/.exec(text);
  const ad = /\[AD\]([\s\S]*?)\[\/AD\]/.exec(text);
  if (!ad) return null;
  const port = parseInt(String(ad[1]).trim(), 10);
  if (!port || port < 1 || port > 65535) return null;
  return { motd: stripFormatting(motd ? motd[1] : '') || 'Мир Minecraft', port };
}

function snapshot() {
  const now = Date.now();
  return {
    ...status,
    addresses: localAddresses(),
    worlds: [...peers.values()]
      .filter((p) => now - p.lastSeen < EXPIRE_MS)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((p) => ({
        id: p.id,
        motd: p.motd,
        address: p.address,
        port: p.port,
        host: p.address + ':' + p.port,
        own: p.own,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
      })),
  };
}

function push() {
  try { notify(snapshot()); } catch { /* окно закрыто */ }
}

function start(onChange) {
  notify = onChange || (() => {});
  if (socket) {
    push();
    return snapshot();
  }

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('error', (err) => {
    // Порт может быть занят другим лаунчером — это не повод падать
    status = { listening: false, error: 'Не удалось слушать сеть: ' + err.message };
    try { sock.close(); } catch { /* уже закрыт */ }
    socket = null;
    push();
  });

  sock.on('message', (msg, rinfo) => {
    const parsed = parseBroadcast(msg.toString('utf8'));
    if (!parsed) return;
    const id = rinfo.address + ':' + parsed.port;
    const existing = peers.get(id);
    peers.set(id, {
      id,
      motd: parsed.motd,
      address: rinfo.address,
      port: parsed.port,
      own: isLocalAddress(rinfo.address),
      firstSeen: existing ? existing.firstSeen : Date.now(),
      lastSeen: Date.now(),
    });
    if (!existing) push();
  });

  sock.on('listening', () => {
    // Подписываемся на каждом интерфейсе: на машине с VPN или Hyper-V основным
    // оказывается виртуальный адаптер, и пакеты из настоящей сети не приходят
    const membership = discovery.joinOnAllInterfaces(sock, MULTICAST_ADDR);
    try { sock.setBroadcast(true); } catch { /* не всякий адаптер это умеет */ }

    status = membership.joined.length
      ? { listening: true, error: null, interfaces: membership.joined.length }
      : { listening: false, error: discovery.describe(membership, false) };
    push();
  });

  try {
    sock.bind(MULTICAST_PORT);
  } catch (e) {
    status = { listening: false, error: 'Не удалось занять порт ' + MULTICAST_PORT + ': ' + e.message };
    push();
    return snapshot();
  }

  socket = sock;
  sweeper = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of peers) {
      if (now - peer.lastSeen >= EXPIRE_MS) { peers.delete(id); changed = true; }
    }
    if (changed) push();
  }, SWEEP_MS);

  return snapshot();
}

function stop() {
  if (sweeper) { clearInterval(sweeper); sweeper = null; }
  if (socket) {
    // Отписываемся на каждом интерфейсе, где подписывались
    for (const iface of discovery.ipv4Interfaces()) {
      try { socket.dropMembership(MULTICAST_ADDR, iface.address); } catch { /* не подписаны */ }
    }
    try { socket.dropMembership(MULTICAST_ADDR); } catch { /* уже отвалилось */ }
    try { socket.close(); } catch { /* уже закрыт */ }
    socket = null;
  }
  peers.clear();
  status = { listening: false, error: null };
}

/* ------------------------- Список серверов игры ------------------------ */

function serversFile(instanceId) {
  return path.join(P.instanceDir(instanceId), 'servers.dat');
}

function readServers(instanceId) {
  const file = serversFile(instanceId);
  if (!fs.existsSync(file)) return { root: { servers: { type: nbt.TAG.LIST, value: { itemType: nbt.TAG.COMPOUND, items: [] } } } };
  try {
    const parsed = nbt.read(fs.readFileSync(file));
    if (!parsed.value.servers) {
      parsed.value.servers = { type: nbt.TAG.LIST, value: { itemType: nbt.TAG.COMPOUND, items: [] } };
    }
    return { root: parsed.value };
  } catch {
    throw new Error('Файл списка серверов повреждён — удалите servers.dat в папке сборки');
  }
}

function listServers(instanceId) {
  const { root } = readServers(instanceId);
  return (root.servers.value.items || []).map((item) => ({
    name: item.name ? item.name.value : '',
    ip: item.ip ? item.ip.value : '',
  }));
}

/**
 * Добавляет сервер в игровой список сборки. Игра при следующем запуске
 * покажет его в «Сетевой игре» — друзьям не нужно ничего вводить вручную.
 */
function addServer(instanceId, { name, ip }) {
  const address = String(ip || '').trim();
  if (!address) throw new Error('Не указан адрес сервера');
  const title = String(name || address).trim().slice(0, 64);

  const dir = P.instanceDir(instanceId);
  if (!fs.existsSync(dir)) throw new Error('Сборка не найдена');

  const { root } = readServers(instanceId);
  const items = root.servers.value.items;

  const existing = items.find((item) => item.ip && item.ip.value === address);
  if (existing) {
    existing.name = { type: nbt.TAG.STRING, value: title };
  } else {
    items.push({
      name: { type: nbt.TAG.STRING, value: title },
      ip: { type: nbt.TAG.STRING, value: address },
    });
  }
  root.servers.value.itemType = nbt.TAG.COMPOUND;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(serversFile(instanceId), nbt.write('', root));
  return { name: title, ip: address, total: items.length };
}

function removeServer(instanceId, ip) {
  const { root } = readServers(instanceId);
  const before = root.servers.value.items.length;
  root.servers.value.items = root.servers.value.items.filter((item) => !item.ip || item.ip.value !== ip);
  fs.writeFileSync(serversFile(instanceId), nbt.write('', root));
  return before !== root.servers.value.items.length;
}

module.exports = { start, stop, snapshot, addServer, removeServer, listServers, localAddresses, parseBroadcast };
