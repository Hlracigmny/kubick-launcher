'use strict';
const { app } = require('electron');
const fsMod = require('fs');
const pathMod = require('path');
const P = require('./paths');

const PKG = require('../../package.json');

/**
 * ============================================================================
 *  ОТКУДА БЕРУТСЯ ОБНОВЛЕНИЯ
 * ============================================================================
 *
 * Из GitHub Releases репозитория, указанного в package.json → "repository".
 * Это единственное место, которое нужно заполнить:
 *
 *     "repository": "https://github.com/ваш-логин/kubick-launcher"
 *
 * Тот же адрес использует electron-builder при публикации (npm run release),
 * поэтому приложение и сборка не могут разъехаться.
 *
 * Пока там стоит заглушка, проверка обновлений не запускается — лаунчер не будет
 * впустую стучаться в несуществующий репозиторий.
 *
 * Обновления работают только в установленной версии: в режиме `npm start`
 * и в портативной сборке проверка отключена — там обновлять нечего.
 */
function repositoryFeed() {
  const raw = typeof PKG.repository === 'string'
    ? PKG.repository
    : (PKG.repository && PKG.repository.url) || '';
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/i.exec(String(raw));
  if (!m) return null;
  const [, owner, repo] = m;
  // Заглушку из шаблона за настроенный репозиторий не считаем
  if (/^(owner|ваш-логин|your-username)$/i.test(owner)) return null;
  return { provider: 'github', owner, repo };
}

const FEED = repositoryFeed();

/**
 * Переопределение источника через переменную окружения — чтобы проверить
 * канал обновлений до публикации, не пересобирая приложение:
 *   KUBICK_UPDATE_FEED=https://example.com/updates/
 */
function feed() {
  const override = process.env.KUBICK_UPDATE_FEED;
  if (override) return { provider: 'generic', url: override };
  return FEED;
}

/** Проверка в режиме разработки включается только явно. */
function devChecksAllowed() {
  return Boolean(process.env.KUBICK_UPDATE_DEV || process.env.KUBICK_UPDATE_FEED);
}

/**
 * Пишем ход проверки в отдельный файл: у GUI-приложения на Windows нет консоли,
 * и без этого журнала разобраться, почему обновление не пришло, невозможно.
 */
function log(message) {
  try {
    fsMod.mkdirSync(P.logs, { recursive: true });
    fsMod.appendFileSync(pathMod.join(P.logs, 'updater.log'),
      new Date().toISOString() + '  ' + message + '\n');
  } catch {
    // журнал не должен мешать работе приложения
  }
}

const state = {
  status: 'disabled',   // disabled | idle | checking | available | downloading | ready | error | latest
  version: null,
  notes: null,
  percent: 0,
  error: null,
  checkedAt: null,
};

let updater = null;
let notify = () => {};

function isConfigured() {
  return Boolean(feed());
}

/** Портативная сборка распаковывается во временную папку — обновлять её нельзя. */
function isPortable() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}

function availability() {
  if (!isConfigured()) return { ok: false, reason: 'disabled' };
  if (!app.isPackaged && !devChecksAllowed()) return { ok: false, reason: 'dev' };
  if (isPortable()) return { ok: false, reason: 'portable' };
  return { ok: true };
}

function snapshot() {
  const avail = availability();
  return {
    ...state,
    configured: isConfigured(),
    supported: avail.ok,
    reason: avail.reason || null,
    currentVersion: app.getVersion(),
  };
}

function push(patch) {
  const before = state.status;
  Object.assign(state, patch);
  if (state.status !== before) {
    log(state.status +
      (state.version ? ' ' + state.version : '') +
      (state.error ? ' — ' + state.error : ''));
  }
  try { notify(snapshot()); } catch { /* окно закрыто */ }
}

function load() {
  if (updater) return updater;
  // Загружаем electron-updater только когда он действительно нужен:
  // в выключенном состоянии модуль не трогает сеть и не пишет в лог
  const { autoUpdater } = require('electron-updater');
  // По умолчанию спрашиваем пользователя: обновление весит десятки мегабайт,
  // качать их без спроса неправильно. Переменная нужна для проверки канала обновлений.
  autoUpdater.autoDownload = process.env.KUBICK_UPDATE_AUTODOWNLOAD === '1';
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.forceDevUpdateConfig = !app.isPackaged;
  autoUpdater.setFeedURL(feed());

  autoUpdater.on('checking-for-update', () => push({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => push({
    status: 'available', version: info.version, notes: normalizeNotes(info.releaseNotes), percent: 0,
  }));
  autoUpdater.on('update-not-available', () => push({ status: 'latest', checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => push({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => push({ status: 'ready', version: info.version, percent: 100 }));
  autoUpdater.on('error', (err) => push({ status: 'error', error: friendlyError(err) }));

  updater = autoUpdater;
  return updater;
}

/** Сырые ошибки electron-updater нечитаемы — переводим частые случаи. */
function friendlyError(err) {
  const raw = (err && err.message) || String(err);
  if (/No published versions/i.test(raw) || (/latest\.yml/i.test(raw) && /404|Cannot find/i.test(raw))) {
    return 'В репозитории ещё нет выпущенной версии. Опубликуйте релиз — тогда обновления заработают.';
  }
  if (/404/.test(raw) && /repos?/i.test(raw)) {
    return 'Репозиторий обновлений не найден — проверьте поле repository в package.json.';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/i.test(raw)) {
    return 'Нет связи с сервером обновлений — проверьте интернет.';
  }
  if (/rate limit/i.test(raw)) return 'GitHub временно ограничил число запросов, попробуйте позже.';
  return raw.split('\n')[0].slice(0, 200);
}

function normalizeNotes(notes) {
  if (!notes) return null;
  if (typeof notes === 'string') return notes.replace(/<[^>]+>/g, '').trim().slice(0, 1200);
  if (Array.isArray(notes)) {
    return notes.map((n) => String(n.note || '').replace(/<[^>]+>/g, '')).join('\n').trim().slice(0, 1200);
  }
  return null;
}

async function check() {
  const avail = availability();
  if (!avail.ok) return snapshot();
  try {
    await load().checkForUpdates();
  } catch (e) {
    push({ status: 'error', error: e.message });
  }
  return snapshot();
}

async function download() {
  const avail = availability();
  if (!avail.ok) throw new Error('Обновления недоступны в этой сборке');
  if (state.status !== 'available') throw new Error('Нет обновления к загрузке');
  push({ status: 'downloading', percent: 0 });
  await load().downloadUpdate();
  return snapshot();
}

/** Закрывает приложение и ставит скачанное обновление. */
function install() {
  if (state.status !== 'ready') throw new Error('Обновление ещё не загружено');
  setImmediate(() => load().quitAndInstall(false, true));
  return true;
}

/**
 * Тихая проверка при старте: пользователь узнаёт о новой версии сам,
 * без модальных окон и без загрузки трафика без спроса.
 */
function init(onChange) {
  notify = onChange || (() => {});
  const avail = availability();
  if (!avail.ok) {
    state.status = 'disabled';
    log('обновления не проверяются: ' + avail.reason);
    return;
  }
  state.status = 'idle';
  log('источник: ' + JSON.stringify(feed()) + ', текущая версия ' + app.getVersion());
  setTimeout(() => { check().catch(() => {}); }, 8000);
}

module.exports = { init, check, download, install, snapshot, isConfigured };
