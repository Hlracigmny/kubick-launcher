'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

// Все данные лежат рядом в одном корне, чтобы лаунчер был переносимым и предсказуемым.
function defaultRoot() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.kubick-launcher');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'kubick-launcher');
  }
  return path.join(os.homedir(), '.kubick-launcher');
}

const ROOT = process.env.KUBICK_LAUNCHER_ROOT || defaultRoot();

const P = {
  root: ROOT,
  versions: path.join(ROOT, 'versions'),
  libraries: path.join(ROOT, 'libraries'),
  assets: path.join(ROOT, 'assets'),
  assetIndexes: path.join(ROOT, 'assets', 'indexes'),
  assetObjects: path.join(ROOT, 'assets', 'objects'),
  natives: path.join(ROOT, 'natives'),
  instances: path.join(ROOT, 'instances'),
  java: path.join(ROOT, 'java'),
  fonts: path.join(ROOT, 'fonts'),
  backgrounds: path.join(ROOT, 'backgrounds'),
  cache: path.join(ROOT, 'cache'),
  logs: path.join(ROOT, 'logs'),
  settingsFile: path.join(ROOT, 'settings.json'),
  accountsFile: path.join(ROOT, 'accounts.json'),
  instancesFile: path.join(ROOT, 'instances.json'),
  friendsFile: path.join(ROOT, 'friends.json'),
};

function ensureDirs() {
  for (const key of ['root', 'versions', 'libraries', 'assets', 'assetIndexes', 'assetObjects', 'natives', 'instances', 'java', 'fonts', 'backgrounds', 'cache', 'logs']) {
    fs.mkdirSync(P[key], { recursive: true });
  }
}

// Путь к jar/json конкретной версии
P.versionDir = (id) => path.join(P.versions, id);
P.versionJson = (id) => path.join(P.versions, id, id + '.json');
P.versionJar = (id) => path.join(P.versions, id, id + '.jar');
P.instanceDir = (id) => path.join(P.instances, id);
P.ensureDirs = ensureDirs;

module.exports = P;
