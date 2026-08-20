'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const P = require('./paths');
const { store } = require('./store');
const manifest = require('./mc/manifest');
const instances = require('./instances');
const launcher = require('./mc/launch');
const javaMod = require('./java');
const accounts = require('./auth/accounts');
const mods = require('./mods');
const updater = require('./updater');
const fonts = require('./fonts');
const modpacks = require('./modpacks');
const lan = require('./lan');
const backgrounds = require('./backgrounds');
const friends = require('./friends');
const themes = require('./themes');
const vpn = require('./vpn');
const idata = require('./instance-data');
const mcping = require('./mcping');

let win = null;
let tray = null;
let quitting = false;
let trayHintShown = false;
let msaCancel = false;

P.ensureDirs();

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    frame: false,
    backgroundColor: '#0e0e14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Внешние ссылки открываем в системном браузере, а не внутри лаунчера
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Закрытие может означать «свернуть в трей» — тогда окно только прячется
  win.on('close', (e) => {
    if (quitting || !store.settings.minimizeToTray) return;
    e.preventDefault();
    win.hide();
    ensureTray();
    if (!trayHintShown) {
      trayHintShown = true;
      if (tray) {
        tray.displayBalloon({
          title: 'Kubick Launcher свернулся',
          content: 'Лаунчер продолжает работать в области уведомлений. Полностью закрыть — через меню значка.',
        });
      }
    }
  });

  win.on('closed', () => { win = null; });
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

/* ------------------------------- Трей ------------------------------ */

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Значок в области уведомлений создаётся лениво — он нужен только при сворачивании. */
function ensureTray() {
  if (tray) return tray;
  // Иконка лежит внутри src: папка build в собранное приложение не попадает
  const iconPath = path.join(__dirname, '..', 'renderer', 'icon.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  else image = image.resize({ width: 16, height: 16 });

  tray = new Tray(image);
  tray.setToolTip('Kubick Launcher');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Kubick Launcher', click: showWindow },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', showWindow);
  tray.on('click', showWindow);
  return tray;
}

function destroyTray() {
  if (tray) { tray.destroy(); tray = null; }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Оборачивает обработчик: любая ошибка приходит в UI как понятный текст, а не как «Error invoking remote method». */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await fn(...args);
      return { ok: true, data };
    } catch (error) {
      const message = (error && error.message) || String(error);
      console.error('[' + channel + ']', message);
      return { ok: false, error: message };
    }
  });
}

/* ------------------------------ Окно ------------------------------- */

ipcMain.on('window:minimize', () => win && win.minimize());
ipcMain.on('window:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', () => win && win.close());

/* --------------------------- Настройки ----------------------------- */

handle('app:info', async () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  root: P.root,
  electron: process.versions.electron,
  node: process.versions.node,
}));

handle('settings:get', async () => store.settings);
handle('settings:save', async (patch) => {
  const fresh = store.saveSettings(patch);
  // Выключили сворачивание — значок в трее больше не нужен
  if (patch && 'minimizeToTray' in patch && !fresh.minimizeToTray) destroyTray();
  return fresh;
});
handle('settings:reveal', async (which) => {
  const target = which === 'logs' ? P.logs : P.root;
  await shell.openPath(target);
  return target;
});

/* ---------------------------- Версии ------------------------------- */

handle('versions:list', async (opts) => {
  const list = await manifest.listVersions({ snapshots: (opts && opts.snapshots) || false });
  const latest = await manifest.latest();
  const installedIds = new Set(fs.existsSync(P.versions) ? fs.readdirSync(P.versions) : []);
  return {
    latest,
    versions: list.map((v) => ({ ...v, installed: installedIds.has(v.id) })),
  };
});

handle('loader:versions', async ({ loader, mcVersion }) => instances.loaderVersions(loader, mcVersion));

/* ---------------------------- Сборки ------------------------------- */

handle('instances:list', async () => {
  const list = instances.list();
  const active = new Set(launcher.runningIds());
  return list.map((i) => ({ ...i, running: active.has(i.id) }));
});

handle('instances:create', async (payload) => {
  const inst = await instances.create(payload, (p) => send('task:progress', { scope: 'create', ...p }));
  return inst;
});

handle('instances:update', async ({ id, patch }) => {
  const inst = store.getInstance(id);
  if (!inst) throw new Error('Сборка не найдена');
  return store.upsertInstance({ ...inst, ...patch, id });
});

handle('instances:delete', async ({ id, deleteFiles }) => instances.remove(id, deleteFiles));
handle('instances:duplicate', async ({ id, name }) => instances.duplicate(id, name));
handle('instances:repair', async ({ id }) =>
  instances.repair(id, (p) => send('task:progress', { scope: 'repair', ...p })));

handle('instances:openFolder', async ({ id, sub }) => {
  const dir = sub ? path.join(P.instanceDir(id), sub) : P.instanceDir(id);
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return dir;
});

/* ---------------------------- Запуск ------------------------------- */

handle('game:launch', async ({ id }) => {
  const inst = store.getInstance(id);
  if (!inst) throw new Error('Сборка не найдена');

  let account = store.getActiveAccount();
  if (!account) throw new Error('Добавьте аккаунт, чтобы играть');

  if (account.type === 'microsoft') {
    const fresh = await accounts.refreshAccount(store.settings.azureClientId, account);
    if (fresh !== account) {
      const idx = store.accounts.list.findIndex((a) => a.id === account.id);
      if (idx >= 0) store.accounts.list[idx] = { ...fresh, id: account.id };
      store.saveAccounts();
      account = { ...fresh, id: account.id };
    }
  }

  const started = Date.now();
  const result = await launcher.launchInstance(inst, account, store.settings, (event) => {
    if (event.type === 'progress') send('task:progress', { scope: 'launch', ...event });
    else if (event.type === 'log') send('game:log', event);
    else if (event.type === 'started') send('game:started', event);
    else if (event.type === 'exit') {
      const played = Math.max(0, Math.round((Date.now() - started) / 1000));
      const current = store.getInstance(id);
      if (current) {
        store.upsertInstance({ ...current, lastPlayed: Date.now(), playTime: (current.playTime || 0) + played });
      }
      send('game:exit', event);
    }
  });

  const current = store.getInstance(id);
  if (current) store.upsertInstance({ ...current, lastPlayed: Date.now() });
  if (store.settings.closeOnLaunch && win) win.minimize();
  return result;
});

handle('game:stop', async ({ id }) => launcher.stop(id));
handle('game:running', async () => launcher.runningIds());

/* ---------------------------- Аккаунты ----------------------------- */

handle('accounts:list', async () => ({
  list: store.accounts.list.map((a) => ({
    id: a.id, type: a.type, name: a.name, uuid: a.uuid, skinUrl: a.skinUrl || null, addedAt: a.addedAt,
  })),
  activeId: store.accounts.activeId,
}));

handle('accounts:addOffline', async ({ name }) => {
  const account = accounts.createOffline(name);
  if (store.accounts.list.some((a) => a.id === account.id)) throw new Error('Такой аккаунт уже добавлен');
  store.accounts.list.push(account);
  if (!store.accounts.activeId) store.accounts.activeId = account.id;
  store.saveAccounts();
  return account;
});

handle('accounts:msStart', async () => {
  msaCancel = false;
  const flow = await accounts.startDeviceFlow(store.settings.azureClientId);

  // Опрос идёт в фоне: UI сразу показывает код, а результат придёт событием
  accounts.loginMicrosoft(store.settings.azureClientId, flow, () => msaCancel)
    .then((account) => {
      const idx = store.accounts.list.findIndex((a) => a.id === account.id);
      if (idx >= 0) store.accounts.list[idx] = account;
      else store.accounts.list.push(account);
      store.accounts.activeId = account.id;
      store.saveAccounts();
      send('accounts:msDone', { ok: true, account: { id: account.id, name: account.name, uuid: account.uuid, type: 'microsoft', skinUrl: account.skinUrl } });
    })
    .catch((e) => send('accounts:msDone', { ok: false, error: e.message }));

  return { userCode: flow.userCode, verificationUri: flow.verificationUri, expiresIn: flow.expiresIn };
});

handle('accounts:msCancel', async () => { msaCancel = true; return true; });

handle('accounts:remove', async ({ id }) => {
  store.accounts.list = store.accounts.list.filter((a) => a.id !== id);
  if (store.accounts.activeId === id) {
    store.accounts.activeId = store.accounts.list.length ? store.accounts.list[0].id : null;
  }
  store.saveAccounts();
  return true;
});

handle('accounts:setActive', async ({ id }) => {
  if (!store.accounts.list.some((a) => a.id === id)) throw new Error('Аккаунт не найден');
  store.accounts.activeId = id;
  store.saveAccounts();
  return true;
});

/* ------------------------------ Java ------------------------------- */

handle('java:scan', async () => javaMod.scan(true));
handle('java:install', async ({ major }) =>
  javaMod.install(major, (p) => send('task:progress', { scope: 'java', ...p })));

handle('java:pick', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Выберите исполняемый файл java',
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const info = await javaMod.probe(result.filePaths[0]);
  if (!info) throw new Error('Это не похоже на рабочий java-файл');
  return info;
});

/* ------------------------------ Моды ------------------------------- */

handle('mods:search', async (opts) => mods.search(opts, store.settings));
handle('mods:versions', async (opts) => mods.versions(opts, store.settings));

handle('mods:install', async ({ instanceId, version, projectType }) => {
  const inst = store.getInstance(instanceId);
  if (!inst) throw new Error('Сначала выберите сборку');
  const installedFiles = await mods.install({
    version,
    instanceDir: P.instanceDir(instanceId),
    projectType,
    gameVersion: inst.mcVersion,
    loader: inst.loader,
  }, store.settings, (p) => send('task:progress', { scope: 'mods', ...p }));

  const current = store.getInstance(instanceId);
  const known = (current.mods || []).filter((m) => !installedFiles.some((f) => f.filename === m.filename));
  store.upsertInstance({ ...current, mods: [...known, ...installedFiles] });
  return installedFiles;
});

handle('mods:installed', async ({ instanceId }) => {
  const inst = store.getInstance(instanceId);
  if (!inst) throw new Error('Сборка не найдена');
  const files = mods.listInstalled(P.instanceDir(instanceId));
  const meta = inst.mods || [];
  return files.map((f) => {
    const base = f.filename.replace(/\.disabled$/, '');
    const info = meta.find((m) => m.filename === base) || null;
    return { ...f, name: info ? info.name : base, source: info ? info.source : null, dependency: info ? info.dependency : false };
  });
});

handle('mods:toggle', async ({ filePath, enabled }) => mods.toggle(filePath, enabled));
handle('mods:remove', async ({ filePath }) => { mods.remove(filePath); return true; });

/* --------------------- Содержимое сборки (данные игры) -------------- */

handle('inst:mods', async ({ id }) => idata.mods(id));
handle('inst:packs', async ({ id, sub }) => idata.packs(id, sub));
handle('inst:worlds', async ({ id }) => idata.worlds(id));
handle('inst:screenshots', async ({ id }) => idata.screenshots(id));
handle('inst:logs', async ({ id }) => idata.logFiles(id));
handle('inst:readLog', async ({ file }) => idata.readLog(file));
handle('inst:notes', async ({ id }) => idata.getNotes(id));
handle('inst:saveNotes', async ({ id, text }) => idata.setNotes(id, text));
handle('inst:components', async ({ id }) => {
  const inst = store.getInstance(id);
  if (!inst) throw new Error('Сборка не найдена');
  return idata.components(id, inst);
});
handle('inst:addFiles', async ({ id, sub, kind }) => {
  const filters = kind === 'mod'
    ? [{ name: 'Моды', extensions: ['jar'] }]
    : [{ name: 'Наборы', extensions: ['zip', 'jar'] }];
  const result = await dialog.showOpenDialog(win, {
    title: 'Выберите файлы', properties: ['openFile', 'multiSelections'], filters,
  });
  if (result.canceled || !result.filePaths.length) return { added: 0 };

  const target = idata.dirOf(id, sub);
  fs.mkdirSync(target, { recursive: true });
  let added = 0;
  for (const source of result.filePaths) {
    try {
      fs.copyFileSync(source, path.join(target, path.basename(source)));
      added++;
    } catch {
      // файл занят или нет прав — остальные всё равно скопируем
    }
  }
  return { added };
});

handle('inst:pingServers', async ({ addresses }) => mcping.pingAll(addresses));
handle('inst:openFile', async ({ file }) => { await shell.openPath(file); return true; });
handle('inst:showFile', async ({ file }) => { shell.showItemInFolder(file); return true; });
handle('inst:deleteFile', async ({ file, recursive }) => {
  fs.rmSync(file, { force: true, recursive: Boolean(recursive) });
  return true;
});

/* -------------------------------- VPN ------------------------------ */

handle('vpn:countries', async ({ force } = {}) => vpn.countries({ force: Boolean(force) }));
handle('vpn:servers', async ({ code }) => vpn.serversOf(code));
handle('vpn:status', async () => vpn.status());
handle('vpn:saveConfig', async ({ id }) => vpn.saveConfig(id));
handle('vpn:connect', async ({ id }) => vpn.connect(id, (e) => send('vpn:changed', { ...e, status: vpn.status() })));
handle('vpn:disconnect', async () => vpn.disconnect());
handle('vpn:openFolder', async () => {
  const dir = path.join(P.root, 'vpn');
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return dir;
});

/* --------------------------- Картинки тем -------------------------- */

handle('themes:status', async () => themes.status());
handle('themes:ensure', async ({ id, force }) => {
  send('task:progress', { scope: 'theme', label: 'Загрузка картинки темы', done: 0, total: 1 });
  const meta = await themes.ensurePhoto(id, { force: Boolean(force) });
  send('task:progress', { scope: 'theme', label: 'Готово', done: 1, total: 1 });
  return meta;
});
handle('themes:photo', async ({ id }) => themes.photo(id));
handle('themes:clear', async ({ id }) => themes.clear(id));

/* ------------------------------ Друзья ----------------------------- */

handle('friends:status', async () => friends.snapshot());
handle('friends:add', async ({ code, nick }) => friends.add({ code, nick }));
handle('friends:remove', async ({ code }) => friends.remove(code));

/* ------------------------------- Фон ------------------------------- */

handle('bg:pick', async () => backgrounds.pick(win));
handle('bg:image', async ({ name }) => backgrounds.dataUrl(name));
handle('bg:clear', async ({ name }) => backgrounds.clear(name));

/* --------------------------- Сброс настроек ------------------------ */

handle('settings:reset', async () => {
  // Сбрасываем только настройки: аккаунты, сборки и игровые файлы не трогаем
  const image = store.settings.bgImage;
  const fresh = store.resetSettings();
  if (image) backgrounds.clear(image);
  return fresh;
});

/* --------------------------- Игра по сети -------------------------- */

handle('lan:status', async () => lan.snapshot());
handle('lan:servers', async ({ instanceId }) => lan.listServers(instanceId));
handle('lan:addServer', async ({ instanceId, name, ip }) => lan.addServer(instanceId, { name, ip }));
handle('lan:removeServer', async ({ instanceId, ip }) => lan.removeServer(instanceId, ip));

/* ------------------------------ Модпаки ---------------------------- */

handle('modpacks:install', async ({ source, version, name }) => {
  const result = await modpacks.install({ source, version, name }, store.settings,
    (p) => send('task:progress', { scope: 'modpack', ...p }));
  return result;
});

/* ------------------------------ Шрифты ----------------------------- */

handle('fonts:list', async () => fonts.list());
handle('fonts:install', async ({ id }) =>
  fonts.install(id, (p) => send('task:progress', { scope: 'fonts', ...p })));
handle('fonts:remove', async ({ id }) => fonts.remove(id));
handle('fonts:css', async ({ id }) => fonts.css(id));

/* --------------------------- Обновления ---------------------------- */

handle('updates:status', async () => updater.snapshot());
handle('updates:check', async () => updater.check());
handle('updates:download', async () => updater.download());
handle('updates:install', async () => updater.install());

/* ----------------------------- Прочее ------------------------------ */

handle('shell:openExternal', async ({ url }) => {
  if (!/^https?:\/\//.test(url)) throw new Error('Разрешены только http(s)-ссылки');
  await shell.openExternal(url);
  return true;
});

handle('logs:read', async ({ id }) => {
  const file = path.join(P.logs, id + '.log');
  if (!fs.existsSync(file)) return '';
  const content = fs.readFileSync(file, 'utf8');
  return content.length > 400000 ? content.slice(-400000) : content;
});

/* ---------------------------- Жизненный цикл ----------------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    createWindow();
    updater.init((snapshot) => send('updates:changed', snapshot));
    lan.start((snapshot) => send('lan:changed', snapshot));
    friends.start((snapshot) => send('friends:changed', snapshot));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => { quitting = true; lan.stop(); friends.stop(); vpn.disconnect(); destroyTray(); });

  app.on('window-all-closed', () => {
    // При сворачивании в трей окна нет, но приложение должно жить дальше
    if (store.settings.minimizeToTray && !quitting) return;
    if (process.platform !== 'darwin') app.quit();
  });

  // Необработанные ошибки не должны молча убивать процесс
  process.on('unhandledRejection', (reason) => {
    console.error('Необработанная ошибка:', reason);
  });
}
