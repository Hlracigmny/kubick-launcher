'use strict';
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

/**
 * Хеширование паролей.
 *
 * По умолчанию argon2id. Если пакет не установлен — scrypt из стандартной
 * библиотеки: argon2 нативный, и на машине без сборочных инструментов
 * `npm install` может не пройти. Уронить из-за этого вход хуже, чем временно
 * работать на scrypt, который OWASP разрешает наравне с argon2 и bcrypt.
 *
 * Чего здесь нет ни при каком раскладе — это голого sha256 по паролю.
 *
 * Формат хранения самоописывающийся, поэтому базу можно перевести на argon2
 * позже: при следующем успешном входе пароль перехешируется сам.
 */

let argon2 = null;
try {
  // eslint-disable-next-line global-require
  argon2 = require('argon2');
} catch {
  console.warn('[passwords] argon2 не установлен, используется scrypt из стандартной библиотеки');
}

// Параметры scrypt: 64 МБ памяти на проверку. Дороже для перебора, терпимо для входа.
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, keylen: 64 };

const ARGON2_OPTIONS = {
  type: 2,               // argon2id
  memoryCost: 65536,     // 64 МБ
  timeCost: 3,
  parallelism: 1,
};

/** Предпочитаемый алгоритм — по нему решается, надо ли перехешировать при входе. */
const PREFERRED = argon2 ? 'argon2id' : 'scrypt';

async function hash(password) {
  assertPassword(password);
  if (argon2) return argon2.hash(password, ARGON2_OPTIONS);

  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

async function verify(stored, password) {
  if (!stored || typeof password !== 'string') return false;

  if (stored.startsWith('$argon2')) {
    if (!argon2) throw new Error('Пароль захеширован argon2, но пакет argon2 не установлен');
    try { return await argon2.verify(stored, password); } catch { return false; }
  }

  if (stored.startsWith('scrypt$')) {
    const [, N, r, p, salt, expected] = stored.split('$');
    let derived;
    try {
      derived = await scrypt(password, Buffer.from(salt, 'base64'), Buffer.from(expected, 'base64').length, {
        N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024,
      });
    } catch {
      return false;
    }
    // Сравнение постоянного времени: обычное === утекает длину совпавшего префикса
    const a = Buffer.from(expected, 'base64');
    return a.length === derived.length && crypto.timingSafeEqual(a, derived);
  }

  return false;
}

/** Нужно ли перехешировать: база могла быть создана до появления argon2. */
function needsRehash(stored) {
  if (!stored) return true;
  if (PREFERRED === 'argon2id') return !stored.startsWith('$argon2');
  return !stored.startsWith('scrypt$');
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    const err = new Error('Пароль должен быть не короче 8 символов');
    err.status = 400;
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
  if (password.length > 200) {
    const err = new Error('Пароль слишком длинный');
    err.status = 400;
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
}

module.exports = { hash, verify, needsRehash, assertPassword, algorithm: PREFERRED };
