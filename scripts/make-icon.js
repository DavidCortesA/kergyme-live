/**
 * Genera el logo y las imágenes de marca renderizando SVG/HTML con Electron:
 *   build/icon.png               1024 px, ícono de Windows (electron-builder lo pasa a .ico)
 *   build/icon-mac.png           1024 px con margen y sombra, como los íconos de macOS (.icns)
 *   src/renderer/assets/icon.png 512 px, ícono de la ventana en desarrollo
 *   build/installerSidebar.bmp   164×314, bienvenida y pantalla final del instalador de Windows
 *   build/installerHeader.bmp    150×57, cabecera de las páginas internas del instalador
 *
 * Mismo cuadrado coral y trazo blanco que Kerygma Converter y Downloader; el símbolo es una torre
 * de transmisión con ondas (Converter usa barras de onda; Downloader, una flecha a una bandeja).
 *
 * Uso:  npm run icon
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BG = '#16171b';
const FONT = "-apple-system, 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif";
const GLYPH = '<circle cx="16" cy="12.2" r="1.7"/><path d="M16 14 11.6 26M16 14l4.4 12M13.2 22.2h5.6M14.4 18.4h3.2"/><path d="M12.2 8.4a5.4 5.4 0 0 0 0 7.6M19.8 8.4a5.4 5.4 0 0 1 0 7.6"/><path d="M9.3 5.6a9.4 9.4 0 0 0 0 13.2M22.7 5.6a9.4 9.4 0 0 1 0 13.2"/>';

/** Logo en un lienzo de `size` px; `inset` deja margen alrededor (íconos de macOS). */
function logoSvg(size, { inset = 0, shadow = false, id = 'g' } = {}) {
  const s = size - inset * 2;
  const k = s / 32;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ff8248"/><stop offset="1" stop-color="#e5482a"/>
      </linearGradient>
      <filter id="${id}s" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="${size * 0.012}" stdDeviation="${size * 0.018}" flood-color="#000" flood-opacity="0.28"/>
      </filter>
    </defs>
    <rect x="${inset}" y="${inset}" width="${s}" height="${s}" rx="${(shadow ? 7.2 : 9) * k}" fill="url(#${id})" ${shadow ? `filter="url(#${id}s)"` : ''}/>
    <g transform="translate(${inset} ${inset}) scale(${k})" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none">${GLYPH}</g>
  </svg>`;
}

const sidebar = `
  <div style="width:164px;height:314px;position:relative;overflow:hidden;background:${BG};font-family:${FONT}">
    <div style="position:absolute;inset:0;background:radial-gradient(120% 70% at 50% 0%, rgba(255,106,61,.28), transparent 70%)"></div>
    <div style="position:absolute;left:0;right:0;bottom:0;height:3px;background:linear-gradient(90deg,#ff8248,#e5482a)"></div>
    <div style="position:absolute;top:58px;left:0;right:0;display:flex;flex-direction:column;align-items:center">
      <div style="filter:drop-shadow(0 8px 18px rgba(229,72,42,.45))">${logoSvg(64, { id: 'sb' })}</div>
      <div style="margin-top:22px;color:#f2f2f4;font-size:20px;font-weight:700;letter-spacing:-.02em">Kerygma</div>
      <div style="margin-top:1px;color:#a3a5ae;font-size:14px;font-weight:500">Live</div>
    </div>
    <div style="position:absolute;bottom:26px;left:0;right:0;text-align:center;color:#6e707a;font-size:10.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase">En vivo</div>
  </div>`;

const header = `
  <div style="width:150px;height:57px;background:${BG};display:flex;align-items:center;gap:9px;padding-left:12px;box-sizing:border-box;font-family:${FONT}">
    ${logoSvg(30, { id: 'hd' })}
    <div style="line-height:1.1">
      <div style="color:#f2f2f4;font-size:13px;font-weight:700;letter-spacing:-.01em">Kerygma</div>
      <div style="color:#a3a5ae;font-size:10.5px">Live</div>
    </div>
  </div>`;

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // cada imagen usa su propia ventana

/**
 * Renderiza HTML fuera de pantalla. En modo offscreen la imagen llega por el evento
 * "paint" (capturePage puede no resolver nunca en Windows).
 */
async function render(markup, width, height, background = 'transparent') {
  const win = new BrowserWindow({
    show: false, width, height, useContentSize: true, frame: false, transparent: background === 'transparent',
    backgroundColor: background === 'transparent' ? '#00000000' : background,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(30);
  let last = null;
  win.webContents.on('paint', (_e, _dirty, image) => { last = image; });
  const html = `<html><body style="margin:0;background:${background};overflow:hidden">${markup}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 1200));
  win.destroy();
  if (!last) throw new Error('No se pudo renderizar la imagen');
  return last.crop({ x: 0, y: 0, width, height }).resize({ width, height, quality: 'best' });
}

/** BMP de 24 bits (el único formato que acepta NSIS), escrito a mano desde el bitmap BGRA. */
function toBmp(image) {
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const dst = (height - 1 - y) * rowSize; // BMP guarda las filas de abajo hacia arriba
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      data[dst + x * 3] = bgra[src];
      data[dst + x * 3 + 1] = bgra[src + 1];
      data[dst + x * 3 + 2] = bgra[src + 2];
    }
  }
  const head = Buffer.alloc(54);
  head.write('BM', 0, 'ascii');
  head.writeUInt32LE(54 + data.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(width, 18);
  head.writeInt32LE(height, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(data.length, 34);
  return Buffer.concat([head, data]);
}

function save(file, buffer) {
  const out = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buffer);
  console.log(`✔ ${file}`);
}

app.whenReady().then(async () => {
  try {
    const icon = await render(logoSvg(1024), 1024, 1024);
    save('build/icon.png', icon.toPNG());
    save('src/renderer/assets/icon.png', icon.resize({ width: 512, height: 512, quality: 'best' }).toPNG());
    save('build/icon-mac.png', (await render(logoSvg(1024, { inset: 100, shadow: true }), 1024, 1024)).toPNG());
    save('build/installerSidebar.bmp', toBmp(await render(sidebar, 164, 314, BG)));
    save('build/installerHeader.bmp', toBmp(await render(header, 150, 57, BG)));
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.exit();
});
