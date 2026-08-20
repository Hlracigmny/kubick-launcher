'use strict';
const crypto = require('crypto');
const { request, readBody, sleep } = require('../net');

const DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const SCOPE = 'XboxLive.signin offline_access';

async function postJson(url, body, headers) {
  const payload = JSON.stringify(body);
  const { res, status } = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(headers || {}) },
    body: payload,
  });
  const text = (await readBody(res)).toString('utf8');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* вернём сырой текст в ошибке */ }
  return { status, json, text };
}

async function postForm(url, fields) {
  const payload = new URLSearchParams(fields).toString();
  const { res, status } = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: payload,
  });
  const text = (await readBody(res)).toString('utf8');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ниже обработаем */ }
  return { status, json, text };
}

async function getJson(url, headers) {
  const { res, status } = await request(url, { headers: { Accept: 'application/json', ...(headers || {}) } });
  const text = (await readBody(res)).toString('utf8');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ниже обработаем */ }
  return { status, json, text };
}

/** UUID как у ванильного сервера в офлайн-режиме: MD5 от "OfflinePlayer:<ник>". */
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // версия 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // вариант RFC 4122
  const hex = hash.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

function createOffline(name) {
  const nick = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) {
    throw new Error('Ник должен содержать 3–16 символов: латиница, цифры и _');
  }
  return {
    id: 'offline:' + nick.toLowerCase(),
    type: 'offline',
    name: nick,
    uuid: offlineUuid(nick),
    accessToken: '0',
    addedAt: Date.now(),
  };
}

/** Шаг 1: получаем код, который пользователь вводит на microsoft.com/link. */
async function startDeviceFlow(clientId) {
  if (!clientId) {
    throw new Error('Не указан Azure Client ID. Откройте Настройки → Аккаунты Microsoft и следуйте инструкции.');
  }
  const { status, json, text } = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope: SCOPE });
  if (status >= 400 || !json || !json.device_code) {
    const desc = (json && (json.error_description || json.error)) || text.slice(0, 200);
    throw new Error('Microsoft отклонил запрос: ' + desc);
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri || 'https://microsoft.com/link',
    expiresIn: json.expires_in || 900,
    interval: Math.max(3, json.interval || 5),
  };
}

/** Шаг 2: опрашиваем Microsoft, пока пользователь не подтвердит вход. */
async function pollDeviceFlow(clientId, flow, shouldCancel) {
  const deadline = Date.now() + flow.expiresIn * 1000;
  let interval = flow.interval;

  while (Date.now() < deadline) {
    if (shouldCancel && shouldCancel()) throw new Error('Вход отменён');
    await sleep(interval * 1000);

    const { json } = await postForm(TOKEN_URL, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: flow.deviceCode,
    });
    if (!json) continue;
    if (json.access_token) return json;

    if (json.error === 'authorization_pending') continue;
    if (json.error === 'slow_down') { interval += 5; continue; }
    if (json.error === 'expired_token') throw new Error('Код истёк, начните вход заново');
    if (json.error === 'authorization_declined') throw new Error('Вход отклонён пользователем');
    throw new Error('Ошибка Microsoft: ' + (json.error_description || json.error));
  }
  throw new Error('Время ожидания истекло — попробуйте войти заново');
}

const XSTS_ERRORS = {
  2148916233: 'У этого аккаунта Microsoft нет профиля Xbox. Создайте его на xbox.com и повторите.',
  2148916235: 'Xbox Live недоступен в стране этого аккаунта.',
  2148916236: 'Для аккаунта требуется подтверждение личности.',
  2148916237: 'Для аккаунта требуется подтверждение личности.',
  2148916238: 'Детский аккаунт: нужно добавить его в семейную группу Microsoft.',
};

/** Обмен токена Microsoft на игровой токен: XBL -> XSTS -> Minecraft Services. */
async function exchangeForMinecraft(msAccessToken) {
  const xbl = await postJson(XBL_URL, {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + msAccessToken },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  if (xbl.status >= 400 || !xbl.json || !xbl.json.Token) {
    throw new Error('Xbox Live отклонил вход (' + xbl.status + ')');
  }
  const uhs = xbl.json.DisplayClaims && xbl.json.DisplayClaims.xui && xbl.json.DisplayClaims.xui[0].uhs;

  const xsts = await postJson(XSTS_URL, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.json.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });
  if (xsts.status >= 400 || !xsts.json || !xsts.json.Token) {
    const code = xsts.json && xsts.json.XErr;
    throw new Error(XSTS_ERRORS[code] || 'XSTS отклонил вход (' + xsts.status + ')');
  }

  const mc = await postJson(MC_LOGIN_URL, {
    identityToken: 'XBL3.0 x=' + uhs + ';' + xsts.json.Token,
  });
  if (mc.status >= 400 || !mc.json || !mc.json.access_token) {
    throw new Error('Minecraft Services отклонил вход (' + mc.status + ')');
  }

  const profile = await getJson(MC_PROFILE_URL, { Authorization: 'Bearer ' + mc.json.access_token });
  if (profile.status === 404) {
    throw new Error('На этом аккаунте Microsoft нет купленной Minecraft: Java Edition');
  }
  if (profile.status >= 400 || !profile.json || !profile.json.id) {
    throw new Error('Не удалось получить профиль игрока (' + profile.status + ')');
  }

  const raw = profile.json.id;
  const uuid = raw.length === 32
    ? raw.slice(0, 8) + '-' + raw.slice(8, 12) + '-' + raw.slice(12, 16) + '-' + raw.slice(16, 20) + '-' + raw.slice(20)
    : raw;

  const skin = (profile.json.skins || []).find((s) => s.state === 'ACTIVE');
  return {
    id: 'msa:' + raw,
    type: 'microsoft',
    name: profile.json.name,
    uuid,
    accessToken: mc.json.access_token,
    xuid: mc.json.username || '0',
    expiresAt: Date.now() + (mc.json.expires_in || 86400) * 1000,
    skinUrl: skin ? skin.url : null,
    addedAt: Date.now(),
  };
}

async function loginMicrosoft(clientId, flow, shouldCancel) {
  const tokens = await pollDeviceFlow(clientId, flow, shouldCancel);
  const account = await exchangeForMinecraft(tokens.access_token);
  account.refreshToken = tokens.refresh_token || null;
  return account;
}

/** Продлевает игровой токен по refresh_token; при неудаче нужен повторный вход. */
async function refreshAccount(clientId, account) {
  if (!account || account.type !== 'microsoft') return account;
  if (account.expiresAt && Date.now() < account.expiresAt - 60000) return account;
  if (!account.refreshToken || !clientId) {
    throw new Error('Сессия Microsoft истекла — войдите в аккаунт заново');
  }
  const { json } = await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: account.refreshToken,
    scope: SCOPE,
  });
  if (!json || !json.access_token) {
    throw new Error('Не удалось продлить сессию Microsoft — войдите заново');
  }
  const fresh = await exchangeForMinecraft(json.access_token);
  fresh.refreshToken = json.refresh_token || account.refreshToken;
  return fresh;
}

module.exports = { createOffline, offlineUuid, startDeviceFlow, loginMicrosoft, refreshAccount, exchangeForMinecraft };
