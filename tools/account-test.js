'use strict';
/**
 * Стенд клиентской части аккаунта: поднимает настоящий сервер на памяти
 * и проверяет вход, офлайн-режим и все неприятные случаи — смену пароля
 * с другого устройства, протухший токен, перенос профиля на чужую машину.
 *
 * Запуск: node tools/account-test.js
 */
const fs = require('fs');
const path = require('path');

const { start } = require('../server/src/server');

const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);

(async () => {
  const app = await start({ port: 0 });
  const base = 'http://127.0.0.1:' + app.port;

  // Сервер задаётся настройкой — подставляем локальный до загрузки клиента
  const { store } = require('../src/main/store');
  store.saveSettings({ accountServer: base });

  const account = require('../src/main/auth/kubick-account');
  const P = require('../src/main/paths');
  const sessionFile = path.join(P.root, 'account.json');

  /* --- Регистрация --- */
  const reg = await account.register({ username: 'Steve', password: 'очень-хороший-пароль' });
  check('регистрация входит в аккаунт', reg.signedIn && reg.online, JSON.stringify(reg).slice(0, 100));
  check('профиль сохранён на диск', fs.existsSync(sessionFile), sessionFile);

  /* --- Токен на диске зашифрован --- */
  const onDisk = fs.readFileSync(sessionFile, 'utf8');
  check('пароля в файле сессии нет', !onDisk.includes('очень-хороший-пароль'), '');
  const saved = JSON.parse(onDisk);
  check('refresh-токен зашифрован', Boolean(saved.refreshBox && saved.refreshBox.value) && !/^ey/.test(saved.refreshBox.value),
    saved.refreshBox && saved.refreshBox.scheme);
  check('способ шифрования записан', ['os', 'fallback'].includes(saved.refreshBox.scheme), saved.refreshBox.scheme);

  /* --- Восстановление сессии при старте --- */
  const restored = await account.restore();
  check('сессия восстанавливается при старте', restored.signedIn && restored.online, JSON.stringify(restored.problem || ''));

  /* --- Офлайн: сервер недоступен --- */
  app.server.close();
  await new Promise((r) => setTimeout(r, 150));

  const offline = await account.restore();
  check('без сети пускает в офлайн-режиме', offline.signedIn && !offline.online, JSON.stringify(offline.problem || ''));
  check('видно, сколько осталось офлайна', offline.offlineDaysLeft === 30, String(offline.offlineDaysLeft));

  let blocked = null;
  try { await account.friends(); } catch (e) { blocked = e.message; }
  check('серверные функции в офлайне закрыты', /без интернета/.test(blocked || ''), blocked);

  /* --- Просроченная офлайн-сессия --- */
  const stale = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  stale.savedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(sessionFile, JSON.stringify(stale), 'utf8');
  account._internal.clearSession.call(null);   // сбрасываем кеш в памяти
  fs.writeFileSync(sessionFile, JSON.stringify(stale), 'utf8');

  const expired = await account.restore();
  check('сессия старше 30 дней не пускает', !expired.signedIn, JSON.stringify(expired));
  check('и объясняет причину', /30 дней/.test(expired.problem || ''), expired.problem);

  /* --- Смена пароля с другого устройства --- */
  const app2 = await start({ port: 0 });
  store.saveSettings({ accountServer: 'http://127.0.0.1:' + app2.port });

  await account.register({ username: 'Alex', password: 'первый-пароль-хороший' });
  const myRefresh = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

  // Другое устройство: свой вход и смена пароля
  const otherLogin = await (await fetch('http://127.0.0.1:' + app2.port + '/v1/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Alex', password: 'первый-пароль-хороший' }),
  })).json();
  await fetch('http://127.0.0.1:' + app2.port + '/v1/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + otherLogin.accessToken },
    body: JSON.stringify({ password: 'первый-пароль-хороший', newPassword: 'второй-пароль-хороший' }),
  });

  // Возвращаем наш старый профиль и пробуем восстановиться
  fs.writeFileSync(sessionFile, JSON.stringify(myRefresh), 'utf8');
  account._internal.clearSession.call(null);
  fs.writeFileSync(sessionFile, JSON.stringify(myRefresh), 'utf8');

  const revoked = await account.restore();
  check('после смены пароля на другом устройстве выкидывает', !revoked.signedIn, JSON.stringify(revoked));
  check('и говорит именно про смену пароля', /Пароль изменён/.test(revoked.problem || ''), revoked.problem);
  check('это не спутано с офлайном', !/интернет|офлайн/i.test(revoked.problem || ''), revoked.problem);

  /* --- Профиль с чужой машины --- */
  const foreign = { user: { username: 'Ghost' }, refreshBox: { scheme: 'fallback', value: Buffer.from('мусор').toString('base64') }, savedAt: Date.now() };
  fs.writeFileSync(sessionFile, JSON.stringify(foreign), 'utf8');
  account._internal.clearSession.call(null);
  fs.writeFileSync(sessionFile, JSON.stringify(foreign), 'utf8');

  const broken = await account.restore();
  check('нечитаемый токен не роняет лаунчер', typeof broken === 'object', '');
  check('и объясняет, что делать', /войдите заново/i.test(broken.problem || ''), broken.problem);

  let failed = 0;
  for (const [name, ok, detail] of results) {
    if (!ok) failed++;
    console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok || !detail ? '' : '  -> ' + detail));
  }
  console.log(failed ? '\n' + failed + ' проверок не прошло' : '\nВсе проверки прошли');

  app2.server.close();
  await app.store.close();
  await app2.store.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('СБОЙ СТЕНДА:', e); process.exit(1); });
