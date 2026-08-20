'use strict';
const crypto = require('crypto');

/**
 * Токены доступа. Формат JWT (HS256), но без зависимости от библиотеки:
 * нужен ровно один алгоритм подписи, а разбор чужих токенов тут не требуется.
 *
 * Отдельной таблицы сессий нет. Чтобы отозвать все refresh-токены пользователя
 * разом, достаточно увеличить у него tokenVersion — старые перестают подходить.
 * Это и происходит при смене пароля.
 */

const ACCESS_TTL = 15 * 60;                 // 15 минут
const REFRESH_TTL = 30 * 24 * 60 * 60;      // 30 дней

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payload, secret, ttlSeconds) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const data = header + '.' + body;
  const signature = base64url(crypto.createHmac('sha256', secret).update(data).digest());
  return data + '.' + signature;
}

/**
 * Проверяет подпись и срок. Разделяет «протух» и «подделан» —
 * пользователю это разные сообщения.
 */
function verify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, code: 'TOKEN_INVALID' };

  const data = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', secret).update(data).digest();
  const actual = fromBase64url(parts[2]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, code: 'TOKEN_INVALID' };
  }

  let payload;
  try { payload = JSON.parse(fromBase64url(parts[1]).toString('utf8')); }
  catch { return { ok: false, code: 'TOKEN_INVALID' }; }

  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, code: 'TOKEN_EXPIRED', payload };
  }
  return { ok: true, payload };
}

const issueAccess = (user, secret) => sign(
  { sub: String(user._id), username: user.username, uuid: user.uuid, kind: 'access' },
  secret, ACCESS_TTL,
);

const issueRefresh = (user, secret) => sign(
  { sub: String(user._id), tokenVersion: user.tokenVersion || 0, kind: 'refresh' },
  secret, REFRESH_TTL,
);

module.exports = { sign, verify, issueAccess, issueRefresh, ACCESS_TTL, REFRESH_TTL };
