'use strict';
/**
 * Проверка настоящей базы: то ли подключение, та ли база, на месте ли индексы
 * и не утёк ли пароль в открытом виде.
 *
 * Запуск:
 *   KUBICK_MONGO_URL="mongodb+srv://..." node server/check-db.js
 *
 * Отвечает на вопросы, которые иначе приходится проверять глазами в интерфейсе
 * Atlas: подключились ли вообще, куда именно легли данные, создались ли
 * уникальные индексы (без них два игрока могут занять один ник) и как выглядит
 * сохранённый пароль.
 *
 * Ничего не меняет — только читает.
 */

const results = [];
const check = (name, ok, detail) => results.push([name, ok, detail]);
const note = (text) => results.push([text, null, null]);

const EXPECTED_INDEXES = [
  { collection: 'users', key: { usernameLower: 1 }, unique: true, why: 'без него два игрока займут один ник' },
  { collection: 'users', key: { email: 1 }, unique: true, why: 'одна почта — один аккаунт' },
  { collection: 'friends', key: { from: 1, to: 1 }, unique: true, why: 'без него заявки в друзья задвоятся' },
];

function sameKey(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => String(a[k]) === String(b[k]));
}

/** Похоже ли значение на настоящий хеш, а не на пароль как есть. */
function looksHashed(value) {
  const text = String(value || '');
  return text.startsWith('$argon2') || text.startsWith('scrypt$');
}

(async () => {
  const url = process.env.KUBICK_MONGO_URL;
  if (!url) {
    console.error('KUBICK_MONGO_URL не задан.\n' +
      'Строку подключения берут в Atlas: Database → Connect → Drivers.\n' +
      'Как её получить и что в ней поправить — в server/MONGODB.md.');
    process.exit(2);
  }

  let MongoClient;
  try {
    ({ MongoClient } = require('mongodb'));
  } catch {
    console.error('Драйвер mongodb не установлен. Выполните: cd server && npm install');
    process.exit(2);
  }

  const { explainMongoError } = require('./src/store');
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 8000 });

  try {
    await client.connect();
  } catch (e) {
    console.error(explainMongoError(e));
    process.exit(1);
  }
  check('подключение к MongoDB', true, '');

  const dbName = String(process.env.KUBICK_MONGO_DB || '').trim();
  const db = dbName ? client.db(dbName) : client.db();

  // Самая частая ошибка настройки: в строке нет имени базы, драйвер берёт test
  check('база названа осмысленно', db.databaseName !== 'test',
    db.databaseName === 'test'
      ? 'база «test» — допишите /kubick в строку подключения или задайте KUBICK_MONGO_DB'
      : '');
  note('база: ' + db.databaseName);

  /* --- Коллекции --- */
  const collections = (await db.listCollections().toArray()).map((c) => c.name);
  note('коллекции: ' + (collections.length ? collections.join(', ') : 'пока нет'));

  if (!collections.includes('users')) {
    note('users ещё не создана — сервер создаёт коллекции и индексы при первом запуске');
  }

  /* --- Индексы --- */
  for (const expected of EXPECTED_INDEXES) {
    if (!collections.includes(expected.collection)) continue;
    let indexes = [];
    try { indexes = await db.collection(expected.collection).indexes(); } catch { /* нет доступа */ }

    const found = indexes.find((i) => sameKey(i.key, expected.key));
    const label = expected.collection + '.' + Object.keys(expected.key).join('+');
    if (!found) {
      check('индекс ' + label, false, 'отсутствует — ' + expected.why);
    } else if (expected.unique && !found.unique) {
      check('индекс ' + label, false, 'есть, но не уникальный — ' + expected.why);
    } else {
      check('индекс ' + label, true, '');
    }
  }

  /* --- Данные --- */
  if (collections.includes('users')) {
    const total = await db.collection('users').countDocuments();
    note('учётных записей: ' + total);

    if (total > 0) {
      const sample = await db.collection('users').find({}, {
        projection: { passwordHash: 1, username: 1, uuid: 1 },
      }).limit(20).toArray();

      const allHashed = sample.every((u) => looksHashed(u.passwordHash));
      check('пароли захешированы', allHashed,
        allHashed ? '' : 'нашлось поле passwordHash, не похожее на хеш — это надо разобрать немедленно');

      const haveUuid = sample.every((u) => /^[0-9a-f-]{36}$/.test(String(u.uuid || '')));
      check('у всех есть offline-UUID', haveUuid, '');

      // Полей с паролем в открытом виде быть не должно вовсе
      const raw = JSON.stringify(sample);
      check('в документах нет поля password', !/"password"\s*:/.test(raw), '');
    }
  }

  /* --- Размер --- */
  try {
    const stats = await db.stats();
    const usedMb = (stats.dataSize || 0) / 1048576;
    note('занято данными: ' + usedMb.toFixed(2) + ' МБ' +
      (usedMb > 400 ? ' — близко к пределу бесплатного M0 (512 МБ)' : ' из 512 МБ на M0'));
  } catch { /* на части тарифов stats закрыт */ }

  await client.close();

  let failed = 0;
  console.log();
  for (const [name, ok, detail] of results) {
    if (ok === null) { console.log('       ' + name); continue; }
    if (!ok) failed++;
    console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok || !detail ? '' : '  -> ' + detail));
  }
  console.log(failed ? '\n' + failed + ' проверок не прошло' : '\nБаза настроена правильно');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Сбой проверки:', e.message); process.exit(1); });
