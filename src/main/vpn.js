'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const P = require('./paths');
const { request, readBody } = require('./net');

/**
 * VPN на списке общедоступных серверов VPN Gate — некоммерческого проекта
 * университета Цукубы. Список открытый, серверы поднимают добровольцы,
 * поэтому денег и регистрации не требуется.
 *
 * Соединение выполняет OpenVPN: лаунчер готовит конфигурацию выбранного сервера
 * и запускает клиент. Своего туннеля мы не пишем — виртуальный сетевой адаптер
 * требует драйвера и прав администратора.
 *
 * Важно понимать: трафик идёт через чужой сервер-доброволец. Для обхода
 * ограничений и игры это нормально, для банка и почты — нет.
 */
const LIST_URLS = [
  'https://www.vpngate.net/api/iphone/',
  'http://www.vpngate.net/api/iphone/',   // на части провайдеров HTTPS к этому домену режется
];
const CACHE_FILE = path.join(P.cache, 'vpngate.csv');
const CACHE_TTL = 30 * 60 * 1000;

let current = null;   // активное подключение

/* -------------------------------- Список -------------------------------- */

async function download() {
  let lastError = null;
  for (const url of LIST_URLS) {
    try {
      const { res, status } = await request(url, {
        timeout: 40000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      const body = await readBody(res);
      if (status === 200 && body.length > 10000) return body.toString('utf8');
      lastError = new Error('Список серверов вернулся пустым (HTTP ' + status + ')');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Не удалось получить список серверов');
}

function parse(text) {
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('*'));
  if (!lines.length) return [];
  const cols = lines[0].replace(/^#/, '').split(',');

  const servers = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    if (parts.length < cols.length) continue;
    const row = {};
    cols.forEach((c, i) => { row[c] = parts[i]; });
    if (!row.CountryLong || !row.OpenVPN_ConfigData_Base64) continue;

    servers.push({
      id: row.HostName + '-' + row.IP,
      host: row.HostName,
      ip: row.IP,
      country: row.CountryLong,
      code: row.CountryShort,
      ping: Number(row.Ping) || 0,
      speedMbps: Math.round((Number(row.Speed) || 0) / 1e6),
      sessions: Number(row.NumVpnSessions) || 0,
      uptimeHours: Math.round((Number(row.Uptime) || 0) / 3600000),
      score: Number(row.Score) || 0,
      config: row.OpenVPN_ConfigData_Base64,
    });
  }
  return servers;
}

async function load({ force = false } = {}) {
  let text = null;
  if (!force) {
    try {
      const stat = fs.statSync(CACHE_FILE);
      if (Date.now() - stat.mtimeMs < CACHE_TTL) text = fs.readFileSync(CACHE_FILE, 'utf8');
    } catch { /* кеша нет */ }
  }

  if (!text) {
    text = await download();
    fs.mkdirSync(P.cache, { recursive: true });
    fs.writeFileSync(CACHE_FILE, text, 'utf8');
  }
  return parse(text);
}

/** Страны со сводкой: сколько серверов, лучший пинг, максимальная скорость. */
async function countries(opts) {
  const servers = await load(opts);
  const byCode = new Map();

  for (const s of servers) {
    const entry = byCode.get(s.code) || {
      code: s.code, name: s.country, count: 0, bestPing: Infinity, maxSpeed: 0,
    };
    entry.count++;
    if (s.ping > 0 && s.ping < entry.bestPing) entry.bestPing = s.ping;
    if (s.speedMbps > entry.maxSpeed) entry.maxSpeed = s.speedMbps;
    byCode.set(s.code, entry);
  }

  return [...byCode.values()]
    .map((c) => ({ ...c, bestPing: Number.isFinite(c.bestPing) ? c.bestPing : 0 }))
    .sort((a, b) => b.count - a.count);
}

/** Серверы одной страны — отсортированы по скорости, самые живые сверху. */
async function serversOf(code, opts) {
  const servers = await load(opts);
  return servers
    .filter((s) => s.code === code)
    .sort((a, b) => b.speedMbps - a.speedMbps || a.ping - b.ping)
    .slice(0, 60)
    .map(({ config, ...rest }) => rest);   // конфиг наружу не отдаём, он большой
}

/* ------------------------------- OpenVPN -------------------------------- */

const OPENVPN_PATHS = [
  'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe',
  'C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn.exe',
  'C:\\Program Files\\OpenVPN Connect\\openvpn.exe',
];

const EXE = process.platform === 'win32' ? 'openvpn.exe' : 'openvpn';

/**
 * Папка со своей копией OpenVPN.
 *
 * В собранном приложении она приезжает через extraResources и лежит рядом
 * с exe, в разработке — в корне репозитория. Файлы туда кладутся отдельно
 * (tools/fetch-openvpn.js): исполняемые файлы чужого проекта в репозитории
 * не хранятся.
 */
function bundledDir() {
  const packed = process.resourcesPath ? path.join(process.resourcesPath, 'openvpn') : null;
  const dev = path.join(__dirname, '..', '..', 'resources', 'openvpn');
  for (const dir of [packed, dev]) {
    if (dir && fs.existsSync(path.join(dir, EXE))) return dir;
  }
  return null;
}

/**
 * Где взять OpenVPN. Своя копия идёт первой: её версия известна, и пользователю
 * не нужно ничего ставить руками.
 *
 * Важно понимать границу. Свой openvpn.exe снимает необходимость устанавливать
 * OpenVPN, но не снимает главного требования: туннелю нужен виртуальный сетевой
 * адаптер, а его драйвер ставится с правами администратора. Полностью «без
 * установки» системный VPN не работает ни у кого — так устроена сама Windows.
 * Если нужен другой адрес только для игры и без прав администратора,
 * для этого есть раздел «Смена IP».
 */
function findOpenVpn() {
  const bundled = bundledDir();
  if (bundled) return path.join(bundled, EXE);

  for (const candidate of OPENVPN_PATHS) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* нет */ }
  }
  return null;
}

/** Откуда взялся найденный OpenVPN — интерфейс объясняет это пользователю. */
function openVpnSource() {
  if (bundledDir()) return 'bundled';
  return findOpenVpn() ? 'system' : null;
}

/** Есть ли рядом драйвер адаптера, который можно поставить самим. */
function bundledDriver() {
  const dir = bundledDir();
  if (!dir) return null;
  for (const name of ['tap-windows.exe', 'tap-windows6.msi', 'wintun.dll']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return { file, name, kind: name.endsWith('.dll') ? 'wintun' : 'tap' };
  }
  return null;
}

async function configFor(serverId) {
  const servers = await load();
  const server = servers.find((s) => s.id === serverId);
  if (!server) throw new Error('Сервер не найден — обновите список');
  const config = Buffer.from(server.config, 'base64').toString('utf8');
  return { server: { ...server, config: undefined }, config };
}

/** Сохраняет .ovpn на диск — им можно подключиться любым клиентом OpenVPN. */
async function saveConfig(serverId) {
  const { server, config } = await configFor(serverId);
  const dir = path.join(P.root, 'vpn');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'vpngate-' + server.code + '-' + server.ip.replace(/\./g, '_') + '.ovpn');
  fs.writeFileSync(file, config, 'utf8');
  return { file, server };
}

function status() {
  return {
    connected: Boolean(current),
    server: current ? current.server : null,
    since: current ? current.since : null,
    openvpn: findOpenVpn(),
    source: openVpnSource(),
    driver: bundledDriver(),
  };
}

/**
 * Поднимает туннель через OpenVPN. Клиенту нужен виртуальный адаптер,
 * поэтому Windows запросит права администратора.
 */
async function connect(serverId, onEvent) {
  if (current) throw new Error('VPN уже подключён — сначала отключитесь');
  const openvpn = findOpenVpn();
  if (!openvpn) {
    throw new Error('OpenVPN не найден. Установите его с openvpn.net или сохраните конфигурацию и подключитесь своим клиентом.');
  }

  const { file, server } = await saveConfig(serverId);
  const emit = (type, payload) => {
    try { (onEvent || (() => {}))({ type, ...payload }); } catch { /* окно закрыто */ }
  };

  const child = spawn(openvpn, ['--config', file], { windowsHide: true });
  current = { child, server, since: Date.now(), file, ready: false };

  const onData = (buf) => {
    const text = buf.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      emit('log', { line });
      if (/Initialization Sequence Completed/i.test(line) && current) {
        current.ready = true;
        emit('connected', { server });
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (err) => {
    current = null;
    emit('error', { error: 'Не удалось запустить OpenVPN: ' + err.message });
  });
  child.on('close', (code) => {
    const wasReady = current && current.ready;
    current = null;
    emit('disconnected', {
      code,
      error: wasReady ? null : 'OpenVPN завершился с кодом ' + code +
        '. Чаще всего это нехватка прав администратора или занятый адаптер.',
    });
  });

  return { server, config: file };
}

function disconnect() {
  if (!current) return false;
  const pid = current.child.pid;
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/f', '/t'], { windowsHide: true }, () => {});
    } else {
      current.child.kill('SIGTERM');
    }
  } catch {
    return false;
  }
  return true;
}

module.exports = {
  countries, serversOf, saveConfig, connect, disconnect, status,
  findOpenVpn, openVpnSource, bundledDir, bundledDriver, load,
};
