'use strict';
const net = require('net');

/**
 * Опрос сервера Minecraft по протоколу Server List Ping (1.7 и новее).
 * Возвращает то же, что игра показывает в списке серверов: описание,
 * версию, количество игроков и задержку.
 *
 * Формат: handshake -> status request -> JSON-ответ -> ping/pong для замера.
 */
const DEFAULT_PORT = 25565;
const TIMEOUT = 5000;

function varInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    bytes.push(b);
  } while (v);
  return Buffer.from(bytes);
}

function packetWithLength(payload) {
  return Buffer.concat([varInt(payload.length), payload]);
}

function stringBytes(text) {
  const buf = Buffer.from(text, 'utf8');
  return Buffer.concat([varInt(buf.length), buf]);
}

/** Читает VarInt из буфера, возвращает значение и сколько байт занято. */
function readVarInt(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, size: pos - offset };
    shift += 7;
    if (shift > 35) break;
  }
  return null;   // пакет пришёл не полностью
}

/** Убирает форматирование и склеивает описание, которое бывает деревом объектов. */
function flattenDescription(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  let out = String(value.text || '');
  for (const child of value.extra || []) out += flattenDescription(child);
  if (Array.isArray(value)) return value.map(flattenDescription).join('');
  return out;
}

function parseAddress(address) {
  const raw = String(address || '').trim();
  const m = /^\[(.+)\]:(\d+)$/.exec(raw);            // IPv6 в скобках
  if (m) return { host: m[1], port: Number(m[2]) };
  const parts = raw.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1])) return { host: parts[0], port: Number(parts[1]) };
  return { host: raw, port: DEFAULT_PORT };
}

function ping(address) {
  const { host, port } = parseAddress(address);
  return new Promise((resolve) => {
    if (!host) { resolve({ online: false, error: 'Пустой адрес' }); return; }

    const started = Date.now();
    const socket = net.createConnection({ host, port, timeout: TIMEOUT });
    let chunks = Buffer.alloc(0);
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* уже закрыт */ }
      resolve(result);
    };

    socket.on('connect', () => {
      // -1 как версия протокола означает «просто спроси статус»
      const handshake = packetWithLength(Buffer.concat([
        varInt(0x00), varInt(0xffffffff >>> 0 & 0), stringBytes(host),
        Buffer.from([(port >> 8) & 0xff, port & 0xff]), varInt(1),
      ]));
      socket.write(handshake);
      socket.write(packetWithLength(varInt(0x00)));   // status request
    });

    socket.on('data', (data) => {
      chunks = Buffer.concat([chunks, data]);

      const head = readVarInt(chunks, 0);
      if (!head) return;
      const total = head.size + head.value;
      if (chunks.length < total) return;             // ждём остаток

      const idInfo = readVarInt(chunks, head.size);
      if (!idInfo) { finish({ online: false, error: 'Некорректный ответ' }); return; }
      const strInfo = readVarInt(chunks, head.size + idInfo.size);
      if (!strInfo) { finish({ online: false, error: 'Некорректный ответ' }); return; }

      const start = head.size + idInfo.size + strInfo.size;
      const json = chunks.subarray(start, start + strInfo.value).toString('utf8');

      try {
        const info = JSON.parse(json);
        finish({
          online: true,
          latency: Date.now() - started,
          motd: flattenDescription(info.description).replace(/§[0-9a-fk-or]/gi, '').trim().slice(0, 120),
          version: (info.version && info.version.name) || '',
          players: (info.players && info.players.online) || 0,
          maxPlayers: (info.players && info.players.max) || 0,
          favicon: (info.favicon && String(info.favicon).startsWith('data:image')) ? info.favicon : null,
        });
      } catch {
        finish({ online: false, error: 'Сервер ответил не по протоколу' });
      }
    });

    socket.on('timeout', () => finish({ online: false, error: 'Сервер не ответил' }));
    socket.on('error', (err) => finish({ online: false, error: shortError(err) }));
  });
}

function shortError(err) {
  const code = err && err.code;
  if (code === 'ENOTFOUND') return 'Адрес не найден';
  if (code === 'ECONNREFUSED') return 'Соединение отклонено';
  if (code === 'ETIMEDOUT') return 'Сервер не отвечает';
  return (err && err.message) || 'Ошибка соединения';
}

/** Опрашивает несколько серверов сразу — список не должен ждать каждый по очереди. */
async function pingAll(addresses) {
  const results = await Promise.all((addresses || []).map(async (a) => ({ address: a, ...(await ping(a)) })));
  return results;
}

module.exports = { ping, pingAll, parseAddress };
