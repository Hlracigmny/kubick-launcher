'use strict';
const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');
const P = require('./paths');

/**
 * Свой фон интерфейса. Картинка копируется в папку лаунчера и отдаётся в окно
 * как data:-URI: renderer работает без доступа к файловой системе, а фон
 * переживает перемещение или удаление исходного файла.
 */
const ALLOWED = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'];
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
};
const MAX_BYTES = 20 * 1024 * 1024;

function fileFor(name) {
  // Имя приходит из настроек — берём только базовое, чтобы не выйти из папки
  return path.join(P.backgrounds, path.basename(String(name || '')));
}

async function pick(win) {
  const result = await dialog.showOpenDialog(win, {
    title: 'Выберите изображение для фона',
    properties: ['openFile'],
    filters: [{ name: 'Изображения', extensions: ALLOWED.map((e) => e.slice(1)) }],
  });
  if (result.canceled || !result.filePaths.length) return null;

  const source = result.filePaths[0];
  const ext = path.extname(source).toLowerCase();
  if (!ALLOWED.includes(ext)) throw new Error('Такой формат не поддерживается');

  const stat = await fs.promises.stat(source);
  if (stat.size > MAX_BYTES) {
    throw new Error('Файл больше 20 МБ — возьмите изображение полегче, иначе интерфейс будет тормозить');
  }

  fs.mkdirSync(P.backgrounds, { recursive: true });
  const name = 'background-' + Date.now() + ext;
  await fs.promises.copyFile(source, path.join(P.backgrounds, name));

  // Прошлые фоны не копим — активным может быть только один
  for (const old of fs.readdirSync(P.backgrounds)) {
    if (old !== name) {
      try { fs.rmSync(path.join(P.backgrounds, old), { force: true }); } catch { /* занят */ }
    }
  }
  return { name, size: stat.size, dataUrl: dataUrl(name) };
}

function dataUrl(name) {
  if (!name) return null;
  const file = fileFor(name);
  try {
    const ext = path.extname(file).toLowerCase();
    const buf = fs.readFileSync(file);
    return 'data:' + (MIME[ext] || 'image/png') + ';base64,' + buf.toString('base64');
  } catch {
    return null;
  }
}

function clear(name) {
  if (name) {
    try { fs.rmSync(fileFor(name), { force: true }); } catch { /* занят */ }
  }
  return true;
}

module.exports = { pick, dataUrl, clear };
