// Генерирует build/icon.png из фирменного знака лаунчера.
// Рисуем тем же Chromium, что рендерит интерфейс, — иконка гарантированно совпадает с UI.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 512;
const OUT = path.join(__dirname, '..', 'build', 'icon.png');

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;background:transparent;overflow:hidden}
  .tile{
    width:${SIZE}px;height:${SIZE}px;border-radius:112px;
    background:linear-gradient(135deg,#7c5cff 0%,#a855f7 45%,#22d3ee 100%);
    display:flex;align-items:center;justify-content:center;
    box-shadow:inset 0 -24px 60px rgba(0,0,0,.22), inset 0 18px 40px rgba(255,255,255,.16);
  }
  svg{width:290px;height:290px;color:#fff;filter:drop-shadow(0 10px 22px rgba(0,0,0,.28))}
</style></head><body>
  <div class="tile">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
         stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
      <path d="m3.3 7 8.7 5 8.7-5"/>
      <path d="M12 22V12"/>
    </svg>
  </div>
</body></html>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false,
    transparent: true, backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  await new Promise((r) => setTimeout(r, 700)); // даём отрисоваться градиенту и теням
  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, png);
  const size = image.getSize();
  console.log('icon.png: ' + size.width + 'x' + size.height + ', ' + Math.round(png.length / 1024) + ' КБ');
  app.exit(0);
});
