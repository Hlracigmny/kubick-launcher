'use strict';
const crypto = require('crypto');

/**
 * Хранилище: MongoDB, а без строки подключения — память.
 *
 * Память нужна не для продакшена, а чтобы сервер и тесты запускались на голой
 * машине без базы. Интерфейс один и тот же, поэтому проверять логику входа
 * можно без Atlas, а подключение к настоящей базе меняет одну переменную среды.
 */

/** Offline-UUID, вычисленный так же, как это делает сам Minecraft. */
function offlineUuid(nick) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + nick, 'utf8').digest();
  // Версия 3 и вариант RFC 4122 — те же биты, что выставляет UUID.nameUUIDFromBytes
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/* ----------------------------- В памяти -------------------------------- */

function memoryStore() {
  const users = new Map();     // id -> user
  const byName = new Map();    // usernameLower -> id
  const friends = [];

  return {
    kind: 'memory',
    async init() { return this; },
    async close() {},

    async findUserByName(username) {
      const id = byName.get(String(username).toLowerCase());
      return id ? { ...users.get(id) } : null;
    },
    async findUserById(id) {
      const user = users.get(String(id));
      return user ? { ...user } : null;
    },
    async createUser(doc) {
      const lower = doc.username.toLowerCase();
      if (byName.has(lower)) {
        const err = new Error('Этот ник уже занят');
        err.status = 409;
        err.code = 'USERNAME_TAKEN';
        throw err;
      }
      const _id = crypto.randomBytes(12).toString('hex');
      const user = { _id, ...doc, usernameLower: lower };
      users.set(_id, user);
      byName.set(lower, _id);
      return { ...user };
    },
    async updateUser(id, patch) {
      const user = users.get(String(id));
      if (!user) return null;
      Object.assign(user, patch);
      return { ...user };
    },

    async listFriends(userId) {
      return friends
        .filter((f) => f.from === String(userId) || f.to === String(userId))
        .map((f) => ({ ...f }));
    },
    async upsertFriend(from, to, status) {
      const existing = friends.find((f) => f.from === String(from) && f.to === String(to));
      if (existing) {
        existing.status = status;
        existing.updatedAt = new Date();
        return { ...existing };
      }
      const rec = { _id: crypto.randomBytes(12).toString('hex'), from: String(from), to: String(to), status, createdAt: new Date(), updatedAt: new Date() };
      friends.push(rec);
      return { ...rec };
    },
  };
}

/* ------------------------------ MongoDB -------------------------------- */

/**
 * Ошибки Atlas приходят машинными и без подсказки, что делать.
 * Переводим три самые частые: на них уходит больше всего времени при настройке.
 */
function explainMongoError(e) {
  const text = String((e && e.message) || e);

  if (/Authentication failed|bad auth/i.test(text)) {
    return 'MongoDB отклонила логин или пароль. Проверьте их в строке подключения; ' +
      'если в пароле есть @ : / ? # или %, его нужно закодировать через encodeURIComponent.';
  }
  if (/IP that isn.t whitelisted|not allowed to connect|ECONNREFUSED|ETIMEDOUT|ReplicaSetNoPrimary/i.test(text)) {
    return 'MongoDB не пускает с этого адреса. В Atlas откройте Network Access ' +
      'и добавьте IP машины, где работает сервер.';
  }
  if (/querySrv|ENOTFOUND|getaddrinfo/i.test(text)) {
    return 'Не удалось разрешить адрес кластера. Проверьте строку подключения ' +
      'и что у сервера есть доступ в интернет и работающий DNS.';
  }
  return 'Не удалось подключиться к MongoDB: ' + text;
}

async function mongoStore(url) {
  // Драйвер требуется только в этой ветке: без базы он и не нужен
  // eslint-disable-next-line global-require
  const { MongoClient, ObjectId } = require('mongodb');
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 8000 });

  try {
    await client.connect();
  } catch (e) {
    const err = new Error(explainMongoError(e));
    err.cause = e;
    throw err;
  }

  // Имя базы: из переменной, иначе из самой строки подключения.
  // Atlas даёт строку без имени базы, и драйвер молча берёт «test» —
  // данные оказываются не там, где их потом ищут.
  const dbName = String(process.env.KUBICK_MONGO_DB || '').trim();
  const db = dbName ? client.db(dbName) : client.db();
  if (db.databaseName === 'test') {
    console.warn('[store] база называется «test» — в строке подключения не указано имя. ' +
      'Задайте KUBICK_MONGO_DB=kubick или допишите /kubick в строку подключения.');
  }

  const users = db.collection('users');
  const friends = db.collection('friends');

  // Уникальность ника обеспечивает база, а не проверка в коде:
  // две одновременные регистрации иначе обе прошли бы проверку
  await users.createIndex({ usernameLower: 1 }, { unique: true });
  await users.createIndex({ email: 1 }, { unique: true, sparse: true });
  await friends.createIndex({ from: 1, to: 1 }, { unique: true });

  const oid = (id) => (id instanceof ObjectId ? id : new ObjectId(String(id)));

  return {
    kind: 'mongodb',
    dbName: db.databaseName,
    async init() { return this; },
    async close() { await client.close(); },

    async findUserByName(username) {
      return users.findOne({ usernameLower: String(username).toLowerCase() });
    },
    async findUserById(id) {
      try { return await users.findOne({ _id: oid(id) }); } catch { return null; }
    },
    async createUser(doc) {
      const lower = doc.username.toLowerCase();
      try {
        const res = await users.insertOne({ ...doc, usernameLower: lower });
        return { _id: res.insertedId, ...doc, usernameLower: lower };
      } catch (e) {
        if (e && e.code === 11000) {
          const err = new Error('Этот ник уже занят');
          err.status = 409;
          err.code = 'USERNAME_TAKEN';
          throw err;
        }
        throw e;
      }
    },
    async updateUser(id, patch) {
      await users.updateOne({ _id: oid(id) }, { $set: patch });
      return users.findOne({ _id: oid(id) });
    },

    async listFriends(userId) {
      return friends.find({ $or: [{ from: oid(userId) }, { to: oid(userId) }] }).toArray();
    },
    async upsertFriend(from, to, status) {
      await friends.updateOne(
        { from: oid(from), to: oid(to) },
        { $set: { status, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      );
      return friends.findOne({ from: oid(from), to: oid(to) });
    },
  };
}

async function open(url) {
  if (!url) {
    console.warn('[store] KUBICK_MONGO_URL не задан — работаем на хранилище в памяти, данные не переживут перезапуск');
    return memoryStore().init();
  }
  const store = await mongoStore(url);
  console.log('[store] MongoDB подключена, база: ' + store.dbName);
  return store.init();
}

module.exports = { open, offlineUuid, memoryStore, explainMongoError };
