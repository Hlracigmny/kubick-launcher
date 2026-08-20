'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const UA = 'KubickLauncher/1.0 (+https://github.com/kubick-launcher)';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function request(url, opts = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Слишком много редиректов: ' + url));
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Некорректный URL: ' + url)); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, {
      method: opts.method || 'GET',
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...(opts.headers || {}) },
      timeout: opts.timeout || 30000,
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        return resolve(request(next, opts, redirects + 1));
      }
      resolve({ res, status: code, headers: res.headers });
    });
    req.on('timeout', () => req.destroy(new Error('Таймаут запроса: ' + url)));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function readBody(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks);
}

async function fetchBuffer(url, opts = {}) {
  const attempts = opts.attempts ?? 3;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const { res, status } = await request(url, opts);
      const buf = await readBody(res);
      if (status >= 400) {
        const err = new Error('HTTP ' + status + ' — ' + url);
        err.status = status;
        err.body = buf.toString('utf8').slice(0, 400);
        // 4xx (кроме 429) повторять бессмысленно — это не сетевой сбой
        if (status < 500 && status !== 429) throw Object.assign(err, { fatal: true });
        throw err;
      }
      return buf;
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      if (i < attempts - 1) await sleep(400 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

async function fetchJson(url, opts = {}) {
  const buf = await fetchBuffer(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  const text = buf.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Сервер вернул не JSON (' + url + '): ' + text.slice(0, 200));
  }
}

function hashFile(file, algorithm) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algorithm);
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function sha1File(file) { return hashFile(file, 'sha1'); }
function sha256File(file) { return hashFile(file, 'sha256'); }

// Файл считается валидным, только если совпал хеш (или, при отсутствии хеша, размер).
async function isValid(file, sha1, size, sha256) {
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size === 0) return false;
    if (typeof size === 'number' && size > 0 && st.size !== size) return false;
    // Mojang подписывает файлы sha1, Adoptium — sha256; поддерживаем оба
    if (sha256) return (await sha256File(file)) === String(sha256).toLowerCase();
    if (sha1) return (await sha1File(file)) === sha1.toLowerCase();
    return true;
  } catch {
    return false;
  }
}

/**
 * Скачивает файл на диск с проверкой целостности.
 * Пишем во временный файл и переименовываем — так частично скачанный файл
 * никогда не попадёт в кеш и не сломает следующий запуск.
 */
async function downloadFile(url, dest, { sha1, sha256, size, attempts = 4, onBytes } = {}) {
  if (await isValid(dest, sha1, size, sha256)) return { skipped: true, dest };
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const { res, status } = await request(url, {});
      if (status >= 400) {
        res.resume();
        const err = new Error('HTTP ' + status + ' — ' + url);
        if (status < 500 && status !== 429) err.fatal = true;
        throw err;
      }
      if (onBytes) res.on('data', (c) => onBytes(c.length));
      await pipeline(res, fs.createWriteStream(tmp));
      if (sha1 || sha256 || size) {
        const ok = await isValid(tmp, sha1, size, sha256);
        if (!ok) throw new Error('Контрольная сумма не совпала: ' + path.basename(dest));
      }
      await fs.promises.rm(dest, { force: true });
      await fs.promises.rename(tmp, dest);
      return { skipped: false, dest };
    } catch (e) {
      lastErr = e;
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      if (e.fatal) break;
      if (i < attempts - 1) await sleep(400 * Math.pow(2, i));
    }
  }
  throw new Error('Не удалось скачать ' + path.basename(dest) + ': ' + (lastErr && lastErr.message));
}

/** Выполняет задачи с ограничением параллелизма; собирает все ошибки, а не падает на первой. */
async function pool(items, limit, worker) {
  const size = Math.max(1, Math.min(limit || 8, 64));
  let cursor = 0;
  const errors = [];
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { await worker(items[i], i); }
      catch (e) { errors.push(e); }
    }
  });
  await Promise.all(runners);
  if (errors.length) {
    const head = errors.slice(0, 3).map((e) => e.message).join('\n');
    throw new Error(`Ошибок при загрузке: ${errors.length}\n${head}`);
  }
}

module.exports = { fetchBuffer, fetchJson, downloadFile, downloadPool: pool, sha1File, sha256File, hashFile, isValid, request, readBody, sleep };
