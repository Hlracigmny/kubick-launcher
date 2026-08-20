'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const P = require('../paths');
const { store } = require('../store');
const { request, readBody } = require('../net');

/**
 * Свой аккаунт Kubick: регистрация, вход и работа без интернета.
 *
 * Как устроен офлайн. После успешного входа профиль и refresh-токен ложатся
 * на диск, токен — зашифрованным. При старте лаунчер сначала пробует обновить
 * сессию на сервере; если сети нет, а сохранённой сессии меньше 30 дней —
 * пускает в офлайн-режиме. Это именно офлайн для *входа*, а не для данных:
 * играть можно, а всё, что требует сервера (друзья, синхронизация), закрыто
 * и честно помечено в интерфейсе.
 *
 * Почему срок ограничен. Иначе украденный ноутбук даёт бессрочный доступ
 * к аккаунту, а сменить пароль удалённо было бы бесполезно.
 */

const SESSION_FILE = () => path.join(P.root, 'account.json');
const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
// Адреса по умолчанию нет намеренно: пока сервер не развёрнут и не прописан
// в настройках, раздел честно говорит «не настроен». Выдуманная заглушка
// давала бы «сервер недоступен» — а это другая беда с другим решением.

/* --------------------------- Шифрование сессии -------------------------- */

/**
 * Ключ для refresh-токена берём у операционной системы: на Windows это DPAPI
 * через safeStorage, ключ привязан к учётной записи Windows и недоступен
 * другому пользователю машины.
 *
 * Запасной путь нужен там, где safeStorage недоступен — например, на Linux
 * без работающего кошелька. Он слабее (ключ выводится из машинных признаков
 * и лежит рядом), поэтому не притворяется равноценным: он спасает от «прочитал
 * файл и забрал токен», но не от того, кто уже выполняет код на этой машине.
 */
function safeStorage() {
  try {
    // electron доступен только внутри приложения; в тестах его нет
    // eslint-disable-next-line global-require
    const { safeStorage: ss } = require('electron');
    return ss && ss.isEncryptionAvailable() ? ss : null;
  } catch {
    return null;
  }
}

function fallbackKey() {
  const material = [os.hostname(), os.userInfo().username, P.root].join('|');
  return crypto.scryptSync(material, 'kubick-account-v1', 32);
}

function encryptSecret(text) {
  const ss = safeStorage();
  if (ss) return { scheme: 'os', value: ss.encryptString(text).toString('base64') };

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', fallbackKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return {
    scheme: 'fallback',
    value: Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64'),
  };
}

function decryptSecret(box) {
  if (!box || !box.value) return null;
  try {
    if (box.scheme === 'os') {
      const ss = safeStorage();
      if (!ss) return null;
      return ss.decryptString(Buffer.from(box.value, 'base64'));
    }
    const raw = Buffer.from(box.value, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', fallbackKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    // Профиль перенесли на другую машину или сменился пользователь Windows
    return null;
  }
}

/* ----------------------------- Хранение --------------------------------- */

let session = null;   // { user, refreshBox, savedAt, accessToken, accessExpiresAt, online }

function loadSession() {
  if (session) return session;
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE(), 'utf8'));
    if (!data || !data.user) return null;
    session = { ...data, accessToken: null, accessExpiresAt: 0, online: false };
    return session;
  } catch {
    return null;
  }
}

function saveSession(next) {
  session = next;
  const onDisk = {
    user: next.user,
    refreshBox: next.refreshBox,
    savedAt: next.savedAt,
    server: next.server,
  };
  try {
    fs.mkdirSync(P.root, { recursive: true });
    const tmp = SESSION_FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2), 'utf8');
    fs.renameSync(tmp, SESSION_FILE());
  } catch (e) {
    console.error('[account] не удалось сохранить сессию:', e.message);
  }
}

function clearSession() {
  session = null;
  try { fs.rmSync(SESSION_FILE(), { force: true }); } catch { /* нечего удалять */ }
}

/* ------------------------------ Запросы --------------------------------- */

function serverUrl() {
  const configured = String(store.settings.accountServer || '').trim();
  return configured ? configured.replace(/\/+$/, '') : null;
}

function isConfigured() {
  return Boolean(serverUrl());
}

/**
 * Отдельная ошибка для ненастроенного сервера.
 * «Не настроен» и «недоступен» выглядят одинаково, но лечатся по-разному:
 * в первом случае надо вписать адрес, во втором — дождаться сети.
 */
class NotConfiguredError extends Error {
  constructor() {
    super('Сервер учётных записей не настроен. Укажите его адрес в Настройках → Интеграции.');
    this.name = 'NotConfiguredError';
    this.code = 'NOT_CONFIGURED';
  }
}

/** Ошибка, по которой интерфейс отличает «нет сети» от «сервер отказал». */
class OfflineError extends Error {
  constructor(cause) {
    super('Сервер учётных записей недоступен');
    this.name = 'OfflineError';
    this.code = 'OFFLINE';
    this.cause = cause;
  }
}

async function api(method, endpoint, body, token) {
  const base = serverUrl();
  if (!base) throw new NotConfiguredError();

  let response;
  try {
    response = await request(base + endpoint, {
      method,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // Сеть не дошла — это не отказ сервера, и трактовать это как выход нельзя
    throw new OfflineError(e);
  }

  const text = (await readBody(response.res)).toString('utf8');
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* пустой или битый ответ */ }

  if (response.status >= 400) {
    const err = new Error(data.error || ('Сервер ответил ' + response.status));
    err.code = data.code || 'HTTP_' + response.status;
    err.status = response.status;
    throw err;
  }
  return data;
}

/* ------------------------------- Вход ----------------------------------- */

function adopt(data) {
  const next = {
    user: data.user,
    refreshBox: encryptSecret(data.refreshToken),
    savedAt: Date.now(),
    server: serverUrl(),
    accessToken: data.accessToken,
    accessExpiresAt: Date.now() + (data.expiresIn || 900) * 1000,
    online: true,
  };
  saveSession(next);
  return snapshot();
}

async function register({ username, password, email }) {
  return adopt(await api('POST', '/v1/register', { username, password, email }));
}

async function login({ username, password }) {
  return adopt(await api('POST', '/v1/login', { username, password }));
}

function logout() {
  clearSession();
  return snapshot();
}

/**
 * Восстановление сессии при старте.
 *
 * Порядок важен: сначала пробуем сервер, и только сетевая ошибка ведёт
 * в офлайн. Отказ сервера (сменили пароль, токен протух) — это именно выход,
 * и притворяться, что мы «просто офлайн», было бы обманом.
 */
async function restore() {
  const saved = loadSession();
  if (!saved) return snapshot();
  if (!isConfigured()) {
    return snapshot({ problem: 'Адрес сервера учётных записей не задан — вход невозможен.' });
  }

  const refreshToken = decryptSecret(saved.refreshBox);
  if (!refreshToken) {
    return snapshot({
      problem: 'Сохранённый вход не читается — похоже, профиль перенесли с другой машины. Войдите заново.',
    });
  }

  try {
    const data = await api('POST', '/v1/refresh', { refreshToken });
    return adopt(data);
  } catch (e) {
    if (e.code === 'OFFLINE') {
      const age = Date.now() - (saved.savedAt || 0);
      if (age <= OFFLINE_GRACE_MS) {
        session = { ...saved, accessToken: null, accessExpiresAt: 0, online: false };
        return snapshot();
      }
      clearSession();
      return snapshot({
        problem: 'Больше 30 дней без связи с сервером — войдите заново, когда появится интернет.',
      });
    }

    // Сервер ответил и отказал: это настоящий выход, с понятной причиной
    clearSession();
    const reason = e.code === 'TOKEN_REVOKED'
      ? 'Пароль изменён на другом устройстве — войдите заново.'
      : e.code === 'TOKEN_EXPIRED'
        ? 'Сессия истекла — войдите снова.'
        : e.message;
    return snapshot({ problem: reason });
  }
}

/** Действующий access-токен: обновляет его, если протух. */
async function accessToken() {
  const current = loadSession();
  if (!current) throw new Error('Вы не вошли в аккаунт');
  if (current.accessToken && Date.now() < current.accessExpiresAt - 30_000) return current.accessToken;

  const refreshToken = decryptSecret(current.refreshBox);
  if (!refreshToken) throw new Error('Сохранённый вход не читается — войдите заново');
  const data = await api('POST', '/v1/refresh', { refreshToken });
  adopt(data);
  return session.accessToken;
}

/** Функции, которым нужен сервер, зовут это первым делом. */
async function requireOnline(what) {
  const current = loadSession();
  if (!current) throw new Error('Сначала войдите в аккаунт Kubick');
  try {
    return await accessToken();
  } catch (e) {
    if (e.code === 'OFFLINE') {
      throw new Error((what || 'Это действие') + ' недоступно без интернета — лаунчер работает офлайн');
    }
    throw e;
  }
}

async function changePassword({ password, newPassword }) {
  const token = await requireOnline('Смена пароля');
  return adopt(await api('POST', '/v1/password', { password, newPassword }, token));
}

async function friends() {
  const token = await requireOnline('Список друзей');
  return api('GET', '/v1/friends', null, token);
}

async function addFriend(username) {
  const token = await requireOnline('Добавление друга');
  return api('POST', '/v1/friends', { username }, token);
}

/** Состояние для интерфейса. Пароля и токенов здесь нет и быть не может. */
function snapshot(extra) {
  const configured = isConfigured();
  const current = session || loadSession();
  if (!current) {
    return { signedIn: false, online: false, configured, server: serverUrl(), user: null, offlineUntil: null, ...(extra || {}) };
  }
  const offlineUntil = (current.savedAt || 0) + OFFLINE_GRACE_MS;
  return {
    signedIn: true,
    online: Boolean(current.online),
    configured,
    user: current.user,
    server: current.server || serverUrl(),
    savedAt: current.savedAt,
    offlineUntil,
    offlineDaysLeft: Math.max(0, Math.ceil((offlineUntil - Date.now()) / 86400000)),
    encryption: current.refreshBox ? current.refreshBox.scheme : null,
    ...(extra || {}),
  };
}

module.exports = {
  register, login, logout, restore, snapshot,
  accessToken, requireOnline, changePassword, friends, addFriend,
  OfflineError, NotConfiguredError, isConfigured, serverUrl, OFFLINE_GRACE_MS,
  // для тестов
  _internal: { encryptSecret, decryptSecret, clearSession, SESSION_FILE },
};
