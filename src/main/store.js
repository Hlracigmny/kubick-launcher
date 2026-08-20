'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./paths');

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return data == null ? fallback : data;
  } catch {
    return fallback;
  }
}

// Атомарная запись: сначала во временный файл, потом rename.
// Иначе внезапное закрытие лаунчера рвёт конфиг и всё ломается при следующем старте.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const DEFAULT_SETTINGS = {
  memoryMb: 4096,
  javaPath: '',            // пусто = автоопределение/автоскачивание
  // Набор проверен запуском на Java 17 и 25. UnlockExperimentalVMOptions обязан идти первым:
  // G1NewSizePercent и G1MaxNewSizePercent — экспериментальные, без него JVM не стартует вообще.
  jvmArgs: '-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1MaxNewSizePercent=40 '
    + '-XX:G1HeapRegionSize=32M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 '
    + '-XX:MaxGCPauseMillis=50 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 '
    + '-XX:+ParallelRefProcEnabled -XX:+DisableExplicitGC',
  width: 1280,
  height: 720,
  fullscreen: false,
  closeOnLaunch: false,
  showSnapshots: false,
  maxDownloads: 12,
  curseforgeKey: '',
  azureClientId: '',
  bgTheme: 'default',   // фон интерфейса
  bgDim: 40,            // затемнение фона, %
  bgAnimate: true,      // анимация фона
  bgImage: '',          // имя файла своего фона
  fontFamily: 'system',
  versionView: 'list',
  accent: 'sand',
  minimizeToTray: false,     // закрытие сворачивает в трей
  windowControls: 'mac',     // стиль кнопок окна
  windowBounds: null,        // запомненный размер окна
  friendCode: '',           // постоянный код для друзей
  autoAddFriendServers: true,
};

class Store {
  constructor() {
    P.ensureDirs();
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(P.settingsFile, {}) };
    this.accounts = readJson(P.accountsFile, { list: [], activeId: null });
    this.instances = readJson(P.instancesFile, { list: [] });
    this.friends = readJson(P.friendsFile, { list: [] });
  }

  saveSettings(patch) {
    this.settings = { ...this.settings, ...(patch || {}) };
    writeJson(P.settingsFile, this.settings);
    return this.settings;
  }

  /** Возвращает настройки к заводским, не трогая аккаунты и сборки. */
  resetSettings() {
    this.settings = { ...DEFAULT_SETTINGS };
    writeJson(P.settingsFile, this.settings);
    return this.settings;
  }

  saveAccounts() { writeJson(P.accountsFile, this.accounts); return this.accounts; }
  saveInstances() { writeJson(P.instancesFile, this.instances); return this.instances; }
  saveFriends() { writeJson(P.friendsFile, this.friends); return this.friends; }

  getInstance(id) { return this.instances.list.find((i) => i.id === id) || null; }

  upsertInstance(inst) {
    const idx = this.instances.list.findIndex((i) => i.id === inst.id);
    if (idx >= 0) this.instances.list[idx] = { ...this.instances.list[idx], ...inst };
    else this.instances.list.push(inst);
    this.saveInstances();
    return this.getInstance(inst.id);
  }

  removeInstance(id) {
    this.instances.list = this.instances.list.filter((i) => i.id !== id);
    this.saveInstances();
  }

  getActiveAccount() {
    if (!this.accounts.activeId) return null;
    return this.accounts.list.find((a) => a.id === this.accounts.activeId) || null;
  }
}

module.exports = { store: new Store(), readJson, writeJson, DEFAULT_SETTINGS };
