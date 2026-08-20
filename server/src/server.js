'use strict';
const http = require('http');
const crypto = require('crypto');
const passwords = require('./passwords');
const tokens = require('./tokens');
const { open, offlineUuid } = require('./store');

/**
 * API учётных записей Kubick.
 *
 * Без фреймворка: маршрутов меньше десятка, а лишняя зависимость в сервисе,
 * который держит пароли, — лишняя поверхность для чужих уязвимостей.
 *
 * POST /v1/register        { username, password, email? }
 * POST /v1/login           { username, password }
 * POST /v1/refresh         { refreshToken }
 * POST /v1/password        { password, newPassword }   требует access
 * GET  /v1/me                                          требует access
 * GET  /v1/friends                                     требует access
 * POST /v1/friends         { username }                требует access
 * GET  /v1/health
 */

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function jsonBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'BODY_TOO_LARGE', 'Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(httpError(400, 'BAD_JSON', 'Тело запроса не разобрано как JSON')); }
    });
    req.on('error', reject);
  });
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Простое ограничение частоты по адресу. Защищает вход от перебора:
 * без него пароль подбирается со скоростью сети.
 */
function rateLimiter({ windowMs = 60_000, max = 20 } = {}) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count++;
    if (hits.size > 10_000) hits.clear();   // грубая защита от разрастания
    return entry.count <= max;
  };
}

function publicUser(user) {
  return {
    id: String(user._id),
    username: user.username,
    uuid: user.uuid,
    email: user.email || null,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
  };
}

async function createApp({ store, secret }) {
  const loginLimit = rateLimiter({ windowMs: 60_000, max: 10 });
  const registerLimit = rateLimiter({ windowMs: 60 * 60_000, max: 10 });

  /** Достаёт пользователя по access-токену из заголовка Authorization. */
  async function requireUser(req) {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const check = tokens.verify(token, secret);
    if (!check.ok) {
      throw httpError(401, check.code,
        check.code === 'TOKEN_EXPIRED' ? 'Сессия истекла' : 'Токен недействителен');
    }
    if (check.payload.kind !== 'access') throw httpError(401, 'TOKEN_INVALID', 'Нужен токен доступа');
    const user = await store.findUserById(check.payload.sub);
    if (!user) throw httpError(401, 'NO_USER', 'Пользователь не найден');
    return user;
  }

  const routes = {
    'GET /v1/health': async () => ({ ok: true, storage: store.kind, passwords: passwords.algorithm }),

    'POST /v1/register': async (req, ip) => {
      if (!registerLimit(ip)) throw httpError(429, 'TOO_MANY', 'Слишком много регистраций, попробуйте позже');
      const body = await jsonBody(req);
      const username = String(body.username || '').trim();

      if (!USERNAME_RE.test(username)) {
        throw httpError(400, 'BAD_USERNAME',
          'Ник: 3–16 символов, латиница, цифры и подчёркивание — как в Minecraft');
      }
      passwords.assertPassword(body.password);

      const email = body.email ? String(body.email).trim().toLowerCase() : null;
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw httpError(400, 'BAD_EMAIL', 'Адрес почты выглядит неправильно');
      }

      const user = await store.createUser({
        username,
        email,
        passwordHash: await passwords.hash(body.password),
        uuid: offlineUuid(username),
        createdAt: new Date(),
        lastLoginAt: new Date(),
        tokenVersion: 0,
      });

      return {
        user: publicUser(user),
        accessToken: tokens.issueAccess(user, secret),
        refreshToken: tokens.issueRefresh(user, secret),
        expiresIn: tokens.ACCESS_TTL,
      };
    },

    'POST /v1/login': async (req, ip) => {
      if (!loginLimit(ip)) throw httpError(429, 'TOO_MANY', 'Слишком много попыток входа, подождите минуту');
      const body = await jsonBody(req);
      const user = await store.findUserByName(String(body.username || '').trim());

      // Один и тот же ответ на «нет такого ника» и «неверный пароль»:
      // иначе форма превращается в проверялку существующих ников
      const ok = user && await passwords.verify(user.passwordHash, String(body.password || ''));
      if (!ok) throw httpError(401, 'BAD_CREDENTIALS', 'Неверный ник или пароль');

      const patch = { lastLoginAt: new Date() };
      // База могла быть создана до появления argon2 — обновляем прозрачно
      if (passwords.needsRehash(user.passwordHash)) {
        patch.passwordHash = await passwords.hash(String(body.password));
      }
      const fresh = await store.updateUser(user._id, patch);

      return {
        user: publicUser(fresh),
        accessToken: tokens.issueAccess(fresh, secret),
        refreshToken: tokens.issueRefresh(fresh, secret),
        expiresIn: tokens.ACCESS_TTL,
      };
    },

    'POST /v1/refresh': async (req) => {
      const body = await jsonBody(req);
      const check = tokens.verify(String(body.refreshToken || ''), secret);
      if (!check.ok) {
        throw httpError(401, check.code,
          check.code === 'TOKEN_EXPIRED'
            ? 'Сессия истекла — войдите заново'
            : 'Токен недействителен');
      }
      if (check.payload.kind !== 'refresh') throw httpError(401, 'TOKEN_INVALID', 'Нужен refresh-токен');

      const user = await store.findUserById(check.payload.sub);
      if (!user) throw httpError(401, 'NO_USER', 'Пользователь не найден');

      // Пароль сменили на другом устройстве — все прежние сессии гаснут
      if ((user.tokenVersion || 0) !== (check.payload.tokenVersion || 0)) {
        throw httpError(401, 'TOKEN_REVOKED', 'Пароль изменён на другом устройстве — войдите заново');
      }

      return {
        user: publicUser(user),
        accessToken: tokens.issueAccess(user, secret),
        refreshToken: tokens.issueRefresh(user, secret),
        expiresIn: tokens.ACCESS_TTL,
      };
    },

    'POST /v1/password': async (req) => {
      const user = await requireUser(req);
      const body = await jsonBody(req);
      const ok = await passwords.verify(user.passwordHash, String(body.password || ''));
      if (!ok) throw httpError(401, 'BAD_CREDENTIALS', 'Текущий пароль неверен');
      passwords.assertPassword(body.newPassword);

      const fresh = await store.updateUser(user._id, {
        passwordHash: await passwords.hash(body.newPassword),
        tokenVersion: (user.tokenVersion || 0) + 1,
      });

      // Себе выдаём свежую пару, чужие устройства получат TOKEN_REVOKED
      return {
        user: publicUser(fresh),
        accessToken: tokens.issueAccess(fresh, secret),
        refreshToken: tokens.issueRefresh(fresh, secret),
        expiresIn: tokens.ACCESS_TTL,
        revokedOtherSessions: true,
      };
    },

    'GET /v1/me': async (req) => ({ user: publicUser(await requireUser(req)) }),

    'GET /v1/friends': async (req) => {
      const user = await requireUser(req);
      const links = await store.listFriends(user._id);
      const out = [];
      for (const link of links) {
        const otherId = String(link.from) === String(user._id) ? link.to : link.from;
        const other = await store.findUserById(otherId);
        if (!other) continue;
        out.push({
          username: other.username,
          uuid: other.uuid,
          status: link.status,
          outgoing: String(link.from) === String(user._id),
        });
      }
      return { friends: out };
    },

    'POST /v1/friends': async (req) => {
      const user = await requireUser(req);
      const body = await jsonBody(req);
      const target = await store.findUserByName(String(body.username || '').trim());
      if (!target) throw httpError(404, 'NO_USER', 'Игрок с таким ником не найден');
      if (String(target._id) === String(user._id)) {
        throw httpError(400, 'SELF', 'Себя в друзья добавить нельзя');
      }
      await store.upsertFriend(user._id, target._id, 'pending');
      return { ok: true, username: target.username };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const key = req.method + ' ' + url.pathname;
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();

    const handler = routes[key];
    if (!handler) { send(res, 404, { error: 'Метод не найден', code: 'NOT_FOUND' }); return; }

    try {
      send(res, 200, await handler(req, ip));
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[' + key + ']', e);
      send(res, status, {
        error: status >= 500 ? 'Внутренняя ошибка сервера' : e.message,
        code: e.code || 'INTERNAL',
      });
    }
  });

  return { server, store };
}

async function start({ port = Number(process.env.PORT) || 8787, mongoUrl = process.env.KUBICK_MONGO_URL } = {}) {
  let secret = process.env.KUBICK_JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('KUBICK_JWT_SECRET обязателен: без него токены подписываются предсказуемым ключом');
    }
    secret = crypto.randomBytes(32).toString('hex');
    console.warn('[server] KUBICK_JWT_SECRET не задан — сгенерирован временный, все сессии умрут при перезапуске');
  }

  const store = await open(mongoUrl);
  const app = await createApp({ store, secret });
  await new Promise((resolve) => app.server.listen(port, resolve));
  console.log('Kubick Account на порту ' + app.server.address().port +
    ' (хранилище: ' + store.kind + ', пароли: ' + passwords.algorithm + ')');
  return { ...app, secret, port: app.server.address().port };
}

if (require.main === module) {
  start().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { start, createApp, offlineUuid };
