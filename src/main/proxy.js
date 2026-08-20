'use strict';
const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;
const crypto = require('crypto');
const { store } = require('./store');
const { fetchJson } = require('./net');

/**
 * Смена IP для игры без прав администратора.
 *
 * Как это работает и чего ждать. Minecraft соединяется с сервером через Netty,
 * а Netty не смотрит на системные настройки прокси Java — просто прописать
 * -DsocksProxyHost недостаточно, трафик всё равно пойдёт напрямую. Поэтому
 * лаунчер поднимает у себя локальный ретранслятор: игра подключается к
 * 127.0.0.1, а лаунчер уже тянет это соединение через SOCKS5-прокси. Для сервера
 * подключение приходит с адреса прокси.
 *
 * Отсюда честные границы:
 *   - меняется IP только тех подключений, которые начинает лаунчер
 *     (кнопка «Подключиться» в разделе «Серверы» и запуск сразу на сервере);
 *   - сервер, вписанный руками внутри игры, пойдёт напрямую;
 *   - системный трафик и другие программы это не затрагивает вовсе.
 *
 * Прокси — чужие машины. Через них видно, к какому серверу вы подключаетесь;
 * пароли и почта через них ходить не должны. Игровой трафик Minecraft
 * шифрован после входа, поэтому для игры это приемлемо.
 */

const IP_SERVICES = [
  { url: 'https://ipwho.is/', pick: (d) => (d && d.success !== false ? { ip: d.ip, country: d.country, code: d.country_code, city: d.city, isp: d.connection && d.connection.isp } : null) },
  { url: 'https://api.ipify.org?format=json', pick: (d) => (d && d.ip ? { ip: d.ip } : null) },
];

/**
 * Готовые пресеты — это адреса **локальных** клиентов, которые уже могут стоять
 * у игрока: Tor, Shadowsocks, Xray. Каждый из них поднимает SOCKS5 на 127.0.0.1
 * по своему порту, и достаточно нажать «Проверить», чтобы узнать, запущен ли он.
 *
 * Чужих публичных прокси здесь намеренно нет. Прокси видит, к какому серверу вы
 * подключаетесь, и списки бесплатных прокси наполняются кем попало и меняются
 * каждый час: вписать туда конкретные адреса значило бы либо выдумать их,
 * либо пожелать удачи. Свой адрес добавляется кнопкой рядом.
 */
const PRESETS = [
  {
    id: 'tor',
    label: 'Tor',
    host: '127.0.0.1',
    port: 9050,
    note: 'Служба Tor. Стандартный порт демона tor',
  },
  {
    id: 'tor-browser',
    label: 'Tor Browser',
    host: '127.0.0.1',
    port: 9150,
    note: 'Tor Browser поднимает свой SOCKS5 на 9150, пока окно открыто',
  },
  {
    id: 'shadowsocks',
    label: 'Shadowsocks',
    host: '127.0.0.1',
    port: 1080,
    note: 'Порт по умолчанию у клиентов Shadowsocks',
  },
  {
    id: 'xray',
    label: 'Xray / V2Ray',
    host: '127.0.0.1',
    port: 10808,
    note: 'Порт по умолчанию у v2rayN и подобных клиентов',
  },
];

/** Пресеты для интерфейса: помечаем те, что уже добавлены. */
function presets() {
  const existing = all();
  return PRESETS.map((p) => ({
    ...p,
    added: existing.some((x) => x.host === p.host && Number(x.port) === p.port),
  }));
}

/* ------------------------------- Хранение ------------------------------- */

function all() {
  return Array.isArray(store.settings.proxies) ? store.settings.proxies : [];
}

function save(list) {
  store.saveSettings({ proxies: list });
  return list;
}

/** Список для интерфейса — пароли наружу не отдаём. */
function list() {
  return all().map(({ password, ...rest }) => ({ ...rest, hasPassword: Boolean(password) }));
}

function get(id) {
  return all().find((p) => p.id === id) || null;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Порт должен быть числом от 1 до 65535');
  return port;
}

function add({ host, port, label, username, password }) {
  const cleanHost = String(host || '').trim();
  if (!cleanHost) throw new Error('Укажите адрес прокси');
  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    label: String(label || '').trim() || cleanHost,
    host: cleanHost,
    port: parsePort(port),
    username: String(username || '').trim(),
    password: String(password || ''),
    addedAt: Date.now(),
  };
  save([...all(), entry]);
  return { ...entry, password: undefined, hasPassword: Boolean(entry.password) };
}

function remove(id) {
  if (active && active.proxy.id === id) stop();
  save(all().filter((p) => p.id !== id));
  return true;
}

/* ----------------------------- Клиент SOCKS5 ---------------------------- */

/**
 * Чтение рукопожатия. Один слушатель на весь обмен и общий буфер: снимать и
 * возвращать данные в поток на каждом шаге нельзя — то, что пришло одним пакетом
 * вместе с ответом, при этом теряется и обмен встаёт.
 */
function handshakeReader(socket) {
  let buffer = Buffer.alloc(0);
  let waiting = null;   // { count, resolve, reject }
  let failure = null;

  const settle = () => {
    if (!waiting) return;
    if (failure) {
      const { reject } = waiting;
      waiting = null;
      reject(failure);
      return;
    }
    if (buffer.length < waiting.count) return;
    const { count, resolve } = waiting;
    waiting = null;
    const out = buffer.subarray(0, count);
    buffer = buffer.subarray(count);
    resolve(out);
  };

  const onData = (chunk) => { buffer = Buffer.concat([buffer, chunk]); settle(); };
  const onError = (err) => { failure = err; settle(); };
  const onEnd = () => { failure = new Error('Прокси закрыл соединение раньше времени'); settle(); };

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('end', onEnd);

  return {
    read(count) {
      return new Promise((resolve, reject) => {
        waiting = { count, resolve, reject };
        settle();
      });
    },
    /** Снимает слушателей и возвращает в поток то, что уже пришло после рукопожатия. */
    release() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      if (buffer.length) socket.unshift(buffer);
      buffer = Buffer.alloc(0);
    },
  };
}

const SOCKS_ERRORS = {
  1: 'общий сбой SOCKS-сервера',
  2: 'соединение запрещено правилами прокси',
  3: 'сеть недоступна',
  4: 'узел недоступен',
  5: 'соединение отклонено',
  6: 'истекло время жизни пакета',
  7: 'команда не поддерживается',
  8: 'тип адреса не поддерживается',
};

/**
 * Поднимает туннель SOCKS5 до host:port и отдаёт готовый сокет.
 * Реализация минимальная и своя: сторонний пакет ради сотни строк не нужен.
 */
function socksConnect(proxy, host, port, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    socket.setTimeout(timeout, () => fail(new Error('Прокси не отвечает')));
    socket.once('error', (e) => fail(new Error('Не удалось соединиться с прокси: ' + e.message)));

    socket.once('connect', async () => {
      const reader = handshakeReader(socket);
      try {
        const auth = proxy.username ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
        socket.write(auth);

        const greeting = await reader.read(2);
        if (greeting[0] !== 0x05) throw new Error('Это не SOCKS5-прокси');

        if (greeting[1] === 0x02) {
          if (!proxy.username) throw new Error('Прокси требует логин и пароль');
          const user = Buffer.from(proxy.username, 'utf8');
          const pass = Buffer.from(proxy.password || '', 'utf8');
          socket.write(Buffer.concat([
            Buffer.from([0x01, user.length]), user,
            Buffer.from([pass.length]), pass,
          ]));
          const authReply = await reader.read(2);
          if (authReply[1] !== 0x00) throw new Error('Прокси отклонил логин или пароль');
        } else if (greeting[1] === 0xff) {
          throw new Error('Прокси не принимает предложенный способ входа');
        } else if (greeting[1] !== 0x00) {
          throw new Error('Прокси требует способ авторизации, который не поддерживается');
        }

        // Адрес отправляем именем, а не разрешаем сами: пусть DNS резолвит прокси
        const name = Buffer.from(host, 'utf8');
        socket.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]));

        const head = await reader.read(4);
        if (head[1] !== 0x00) {
          throw new Error('Прокси не пропустил соединение: ' + (SOCKS_ERRORS[head[1]] || 'код ' + head[1]));
        }
        // Дочитываем адрес привязки, чтобы дальше в потоке были только полезные данные
        if (head[3] === 0x01) await reader.read(4 + 2);
        else if (head[3] === 0x04) await reader.read(16 + 2);
        else if (head[3] === 0x03) {
          const len = await reader.read(1);
          await reader.read(len[0] + 2);
        } else throw new Error('Прокси вернул неизвестный тип адреса');

        reader.release();
        settled = true;
        socket.setTimeout(0);
        socket.removeAllListeners('error');
        socket.on('error', () => socket.destroy());
        resolve(socket);
      } catch (e) {
        reader.release();
        fail(e);
      }
    });
  });
}

/* ------------------------------ Проверка -------------------------------- */

/** Свой внешний IP — как его видит сеть прямо сейчас, без прокси. */
async function externalIp() {
  let lastError = null;
  for (const service of IP_SERVICES) {
    try {
      const data = await fetchJson(service.url, { timeout: 12000, attempts: 1 });
      const picked = service.pick(data);
      if (picked && picked.ip) return picked;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Не удалось определить внешний IP');
}

/** Запрос к https-адресу через уже открытый сокет — так виден IP на выходе прокси. */
function httpsThrough(socket, host, path, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host }, () => {
      secure.write('GET ' + path + ' HTTP/1.1\r\nHost: ' + host +
        '\r\nUser-Agent: KubickLauncher\r\nConnection: close\r\nAccept: application/json\r\n\r\n');
    });
    const chunks = [];
    const timer = setTimeout(() => { secure.destroy(); reject(new Error('Прокси не ответил вовремя')); }, timeout);

    secure.on('data', (c) => chunks.push(c));
    secure.on('error', (e) => { clearTimeout(timer); reject(e); });
    secure.on('close', () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      if (split < 0) return reject(new Error('Ответ через прокси пришёл повреждённым'));
      const body = text.slice(split + 4).replace(/^[0-9a-f]+\r\n/i, '');
      const start = body.indexOf('{');
      const end = body.lastIndexOf('}');
      if (start < 0 || end < 0) return reject(new Error('Ответ через прокси пришёл повреждённым'));
      try { resolve(JSON.parse(body.slice(start, end + 1))); }
      catch { reject(new Error('Ответ через прокси пришёл повреждённым')); }
    });
  });
}

/**
 * Проверка прокси: жив ли, сколько идёт отклик и какой IP видит внешний мир.
 * Именно последнее и отвечает на вопрос «а IP-то поменялся?».
 */
async function check(id) {
  const proxy = get(id);
  if (!proxy) throw new Error('Прокси не найден');

  const started = Date.now();
  let socket;
  try {
    socket = await socksConnect(proxy, 'ipwho.is', 443);
  } catch (e) {
    return { id, ok: false, error: e.message };
  }
  const latency = Date.now() - started;

  try {
    const data = await httpsThrough(socket, 'ipwho.is', '/');
    const result = {
      id, ok: true, latency,
      ip: data.ip || null,
      country: data.country || null,
      code: data.country_code || null,
      city: data.city || null,
      checkedAt: Date.now(),
    };
    remember(id, result);
    return result;
  } catch (e) {
    return { id, ok: false, latency, error: e.message };
  } finally {
    socket.destroy();
  }
}

/** Итог проверки храним рядом с прокси — чтобы список открывался уже с данными. */
function remember(id, result) {
  save(all().map((p) => (p.id === id
    ? { ...p, lastCheck: { ok: result.ok, ip: result.ip, country: result.country, code: result.code, latency: result.latency, at: Date.now() } }
    : p)));
}

/* ---------------------------- Ретранслятор ------------------------------ */

let active = null;   // { proxy, relays: Map<'host:port', {server, port}> }

/**
 * Куда на самом деле ведёт адрес сервера. Minecraft перед подключением смотрит
 * SRV-запись _minecraft._tcp, и многие серверы держат игру на другом порту.
 * Раз соединение вместо игры устанавливаем мы, то и запись читаем сами.
 */
async function resolveMinecraft(host, port) {
  // Явно указанный порт и IP-адреса SRV не используют
  if (port !== 25565 || net.isIP(host)) return { host, port };
  try {
    const records = await dns.resolveSrv('_minecraft._tcp.' + host);
    if (records && records.length) {
      const best = records.slice().sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
      return { host: best.name, port: best.port };
    }
  } catch { /* записи нет — это норма, идём по обычному адресу */ }
  return { host, port };
}

function status() {
  const proxy = active ? { ...active.proxy, password: undefined } : null;
  return {
    connected: Boolean(active),
    proxy,
    relays: active ? active.relays.size : 0,
  };
}

/** Включает режим смены IP: сами соединения поднимаются по мере надобности. */
function start(id) {
  const proxy = get(id);
  if (!proxy) throw new Error('Прокси не найден');
  if (active) stop();
  active = { proxy, relays: new Map() };
  return status();
}

function stop() {
  if (!active) return false;
  for (const relay of active.relays.values()) {
    try { relay.server.close(); } catch { /* уже закрыт */ }
  }
  active = null;
  return true;
}

/**
 * Локальный адрес, подключение к которому уедет через прокси на host:port.
 * Возвращает null, если режим выключен — тогда игра идёт напрямую.
 */
async function relayFor(host, port) {
  if (!active) return null;
  const key = host + ':' + port;
  const existing = active.relays.get(key);
  if (existing) return { host: '127.0.0.1', port: existing.port };

  const proxy = active.proxy;
  // Игра сама читает SRV-запись, а мы соединяемся вместо неё — значит и читать её нам
  const target = await resolveMinecraft(host, port);

  return new Promise((resolve, reject) => {
    const server = net.createServer(async (client) => {
      client.on('error', () => client.destroy());
      let upstream;
      try {
        upstream = await socksConnect(proxy, target.host, target.port);
      } catch {
        client.destroy();
        return;
      }
      upstream.on('error', () => { upstream.destroy(); client.destroy(); });
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });

    server.on('error', (e) => reject(new Error('Не удалось поднять локальный порт: ' + e.message)));
    // Только петлевой интерфейс: наружу этот порт не смотрит
    server.listen(0, '127.0.0.1', () => {
      const localPort = server.address().port;
      if (!active) { server.close(); return resolve(null); }
      active.relays.set(key, { server, port: localPort });
      resolve({ host: '127.0.0.1', port: localPort });
    });
  });
}

module.exports = {
  list, add, remove, check, externalIp, status, start, stop, relayFor, socksConnect,
  presets, PRESETS,
};
