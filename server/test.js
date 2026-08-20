'use strict';
/**
 * Проверка сервера учётных записей на хранилище в памяти.
 * Проходит весь путь: регистрация, вход, отказ по неверному паролю, обновление
 * токена, второе устройство, смена пароля и гашение чужих сессий.
 *
 * Запуск: node server/test.js
 */
const { start } = require('./src/server');
const { offlineUuid } = require('./src/store');

const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);

async function api(base, method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

(async () => {
  const app = await start({ port: 0 });
  const base = 'http://127.0.0.1:' + app.port;

  /* --- Здоровье --- */
  const health = await api(base, 'GET', '/v1/health');
  check('сервер отвечает', health.status === 200 && health.data.ok, JSON.stringify(health.data));

  /* --- Регистрация --- */
  const reg = await api(base, 'POST', '/v1/register', { username: 'Steve', password: 'очень-хороший-пароль' });
  check('регистрация проходит', reg.status === 200 && Boolean(reg.data.accessToken), JSON.stringify(reg.data).slice(0, 120));
  check('uuid считается как в Minecraft', reg.data.user && reg.data.user.uuid === offlineUuid('Steve'),
    reg.data.user && reg.data.user.uuid);

  const dup = await api(base, 'POST', '/v1/register', { username: 'steve', password: 'другой-пароль-тут' });
  check('ник занят регистронезависимо', dup.status === 409 && dup.data.code === 'USERNAME_TAKEN', dup.data.code);

  const weak = await api(base, 'POST', '/v1/register', { username: 'Alex', password: '123' });
  check('короткий пароль отклонён', weak.status === 400 && weak.data.code === 'WEAK_PASSWORD', weak.data.code);

  const badNick = await api(base, 'POST', '/v1/register', { username: 'Стив', password: 'очень-хороший-пароль' });
  check('ник не по правилам Minecraft отклонён', badNick.status === 400 && badNick.data.code === 'BAD_USERNAME', badNick.data.code);

  /* --- Вход --- */
  const login = await api(base, 'POST', '/v1/login', { username: 'Steve', password: 'очень-хороший-пароль' });
  check('вход проходит', login.status === 200 && Boolean(login.data.refreshToken), String(login.status));

  const wrong = await api(base, 'POST', '/v1/login', { username: 'Steve', password: 'не-тот-пароль-совсем' });
  check('неверный пароль отклонён', wrong.status === 401 && wrong.data.code === 'BAD_CREDENTIALS', wrong.data.code);

  const noUser = await api(base, 'POST', '/v1/login', { username: 'Notch', password: 'какой-то-пароль-тут' });
  check('несуществующий ник неотличим от неверного пароля',
    noUser.status === 401 && noUser.data.error === wrong.data.error, noUser.data.error);

  /* --- Токены --- */
  const me = await api(base, 'GET', '/v1/me', null, login.data.accessToken);
  check('access пускает к профилю', me.status === 200 && me.data.user.username === 'Steve', String(me.status));

  const noToken = await api(base, 'GET', '/v1/me');
  check('без токена не пускает', noToken.status === 401, String(noToken.status));

  const forged = await api(base, 'GET', '/v1/me', null, login.data.accessToken.slice(0, -4) + 'AAAA');
  check('подделанная подпись отклонена', forged.status === 401 && forged.data.code === 'TOKEN_INVALID', forged.data.code);

  const refreshed = await api(base, 'POST', '/v1/refresh', { refreshToken: login.data.refreshToken });
  check('refresh выдаёт новую пару', refreshed.status === 200 && Boolean(refreshed.data.accessToken), String(refreshed.status));

  const refreshWithAccess = await api(base, 'POST', '/v1/refresh', { refreshToken: login.data.accessToken });
  check('access вместо refresh не принимается',
    refreshWithAccess.status === 401 && refreshWithAccess.data.code === 'TOKEN_INVALID', refreshWithAccess.data.code);

  /* --- Второе устройство --- */
  const second = await api(base, 'POST', '/v1/login', { username: 'Steve', password: 'очень-хороший-пароль' });
  check('вход со второго устройства работает', second.status === 200, String(second.status));

  /* --- Смена пароля гасит чужие сессии --- */
  const changed = await api(base, 'POST', '/v1/password',
    { password: 'очень-хороший-пароль', newPassword: 'новый-хороший-пароль' }, second.data.accessToken);
  check('пароль сменился', changed.status === 200 && changed.data.revokedOtherSessions, String(changed.status));

  const oldRefresh = await api(base, 'POST', '/v1/refresh', { refreshToken: login.data.refreshToken });
  check('старый refresh погашен с понятным кодом',
    oldRefresh.status === 401 && oldRefresh.data.code === 'TOKEN_REVOKED', oldRefresh.data.code);
  check('и с человеческим текстом', /Пароль изменён/.test(oldRefresh.data.error || ''), oldRefresh.data.error);

  const newRefresh = await api(base, 'POST', '/v1/refresh', { refreshToken: changed.data.refreshToken });
  check('свежий refresh того устройства, где меняли, работает', newRefresh.status === 200, String(newRefresh.status));

  const oldPassword = await api(base, 'POST', '/v1/login', { username: 'Steve', password: 'очень-хороший-пароль' });
  check('старый пароль больше не подходит', oldPassword.status === 401, String(oldPassword.status));

  /* --- Друзья --- */
  await api(base, 'POST', '/v1/register', { username: 'Alex', password: 'ещё-один-пароль-тут' });
  const addSelf = await api(base, 'POST', '/v1/friends', { username: 'Steve' }, changed.data.accessToken);
  check('себя в друзья не добавить', addSelf.status === 400 && addSelf.data.code === 'SELF', addSelf.data.code);

  const addFriend = await api(base, 'POST', '/v1/friends', { username: 'Alex' }, changed.data.accessToken);
  check('заявка в друзья создаётся', addFriend.status === 200, String(addFriend.status));

  const friends = await api(base, 'GET', '/v1/friends', null, changed.data.accessToken);
  check('друг виден в списке',
    friends.data.friends.length === 1 && friends.data.friends[0].status === 'pending',
    JSON.stringify(friends.data.friends));

  /* --- Пароль не утекает --- */
  const dump = JSON.stringify([reg.data, login.data, me.data, friends.data]);
  check('пароль не встречается в ответах API', !dump.includes('очень-хороший-пароль'), '');

  let failed = 0;
  for (const [name, ok, detail] of results) {
    if (!ok) failed++;
    console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok || !detail ? '' : '  -> ' + detail));
  }
  console.log(failed ? '\n' + failed + ' проверок не прошло' : '\nВсе проверки прошли');

  app.server.close();
  await app.store.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('СБОЙ СТЕНДА:', e); process.exit(1); });
