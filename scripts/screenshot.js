/**
 * Captura la interfaz real (HTML/CSS/JS + preload) con datos simulados, sin tocar OBS,
 * el navegador ni la red. Sirve para el README y para revisar el diseño.
 *
 * Uso:  npx electron scripts/screenshot.js [carpeta-de-salida]
 * Genera: 1-inicio, 2-asistente, 3-checklist, 4-audio, 5-camaras, 6-listo, 7-pantalla,
 *         8-pantallas, 9-configuracion, 10-claro (.png)
 */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const settingsSchema = require('../src/core/settings');
const { checklist, setupSummary, serviceFor } = require('../src/core/checklist');

const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'screenshots'));
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cuadros de cámara simulados (degradados con un rótulo).
const frame = (a, b, label) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><text x="16" y="164" font-family="Helvetica" font-size="15" fill="#fff" opacity=".85">${label}</text></svg>`);

const TRANSMISSION = settingsSchema.effective({
  mode: 'transmission', setupDone: true, org: 'Iglesia Central', computerName: 'Mac de transmisión', theme: 'dark',
  transmission: {
    software: 'obs', destination: 'youtube', pageName: 'Iglesia Central', pageUrl: 'youtube.com/@IglesiaCentral', browser: 'chrome',
    audio: { source: 'external', device: '', required: true },
    cameras: [
      { id: 'c1', name: 'Celular 1 · Escenario', type: 'ndi', source: 'IPHONE-ESCENARIO' },
      { id: 'c2', name: 'Celular 2 · Iglesia', type: 'ndi', source: 'IPHONE-IGLESIA' },
      { id: 'c3', name: 'Celular 3 · Público', type: 'ndi', source: 'IPHONE-PUBLICO' },
    ],
    lyrics: { enabled: true, source: 'Letras' },
    obs: { scene: 'Transmisión', titleSource: 'Título' },
  },
  services: [
    { id: 'domingo', name: 'Domingo', weekday: 0, title: 'Culto dominical | Iglesia Central' },
    { id: 'oracion', name: 'Oración', weekday: 3, title: 'Noche de oración | Iglesia Central' },
  ],
});
const SCREEN = settingsSchema.effective({
  mode: 'screen', setupDone: true, org: 'Iglesia Central', computerName: 'Mac de proyección',
  screen: { software: 'holyrics', outputs: [{ id: 'o1', role: 'projector', name: 'Proyector' }, { id: 'o2', role: 'stage', name: 'Retorno del púlpito' }], ndiOut: true },
});

const R = (status, message, details = [], actions = [], extra = {}) => ({ status, message, details, actions, ...extra });
const A = (id, label, primary = false) => ({ id, label, primary });

const READY = {
  internet: R('ok', 'Conexión estable: 48.6 Mbps de subida.', [
    { label: 'Red local', value: '192.168.1.20 (en0)', status: 'ok' }, { label: 'www.youtube.com', value: 'Responde', status: 'ok' },
    { label: 'Latencia', value: '23 ms', status: 'ok' }, { label: 'Subida', value: '48.6 Mbps', status: 'ok' }, { label: 'Bajada', value: '212.4 Mbps' },
    { label: 'Recomendado', value: '9.2 Mbps de subida para 6000 kbps' },
  ], [A('retry', 'Medir de nuevo')]),
  software: R('ok', 'OBS está abierto y conectado.', [
    { label: 'Versión', value: 'OBS 32.2.2 · WebSocket 5.7.4' }, { label: 'Perfil', value: 'Iglesia Central' },
    { label: 'Colección de escenas', value: 'Servicio' }, { label: 'Salida', value: 'Lista (sin transmitir)', status: 'ok' },
  ], [A('open-app', 'Ver en OBS')]),
  page: R('ok', 'Estás en la página correcta.', [{ label: 'Pestaña al frente', value: 'https://studio.youtube.com/channel/UCiglesia/livestreaming', status: 'ok' }], [A('open-page', 'Abrir YouTube Live'), A('open-settings', 'Cambiar navegador o destino')]),
  streamkey: R('ok', 'OBS tiene la clave y el servidor correctos.', [
    { label: 'Destino', value: 'YouTube Live' }, { label: 'Servidor en OBS', value: 'rtmp://a.rtmp.youtube.com/live2', status: 'ok' },
    { label: 'Clave en OBS', value: '••••••••7Q2k', status: 'ok' },
  ], [A('copy-key', 'Copiar clave')]),
  audio: R('ok', 'OBS recibe audio de Scarlett 2i2 USB, no del micrófono de la computadora.', [
    { label: 'Fuente “Consola”', value: 'Scarlett 2i2 USB · externa', status: 'ok' },
    { label: 'Fuente “Mic/Aux”', value: 'MacBook Pro (micrófono) · de la computadora · silenciada' },
    { label: 'Entradas externas conectadas', value: 'Scarlett 2i2 USB' },
    { label: 'Nivel de audio', value: '-12 dB', status: 'ok', meter: -12 },
  ], [A('test-signal', 'Probar señal (5 s)'), A('retry', 'Reintentar'), A('open-settings', 'Cambiar origen del audio')]),
  lyrics: R('ok', 'Llegan las letras y versículos (“Letras”).', [
    { label: 'Fuente', value: '“Letras” recibe imagen', status: 'ok' }, { label: 'Emisores NDI en la red', value: 'MAC-PROYECCION (Holyrics), IPHONE-ESCENARIO, IPHONE-IGLESIA, IPHONE-PUBLICO' },
  ], [A('retry', 'Reintentar')], { preview: frame('#1d2a4a', '#0b0f1c', 'Salmo 23:1 — Jehová es mi pastor') }),
  cameras: R('ok', 'Todas las cámaras están conectadas.', [
    { label: 'Celular 1 · Escenario', value: '“Celular 1 · Escenario” recibe imagen', status: 'ok' },
    { label: 'Celular 2 · Iglesia', value: '“Celular 2 · Iglesia” recibe imagen', status: 'ok' },
    { label: 'Celular 3 · Público', value: '“Celular 3 · Público” recibe imagen', status: 'ok' },
  ], [A('retry', 'Revisar de nuevo')]),
  scenes: R('ok', 'Escena “Transmisión” lista para transmitir.', [
    { label: 'Escena actual', value: 'Transmisión', status: 'ok' }, { label: 'Fuentes visibles', value: 'Celular 1 · Escenario, Letras, Título, Consola', status: 'ok' },
    { label: 'Resolución de salida', value: '1920 × 1080 (30 fps)', status: 'ok' }, { label: 'Estado de salida', value: 'Listo (sin transmitir)', status: 'ok' },
  ], [A('open-app', 'Ver en OBS')]),
  title: R('ok', 'Título listo y copiado para pegarlo en YouTube Live.', [
    { label: 'Servicio', value: 'Domingo' }, { label: 'Título', value: 'Culto dominical | Iglesia Central' }, { label: 'Texto “Título” en OBS', value: 'Culto dominical | Iglesia Central', status: 'ok' },
  ], [A('copy-title', 'Copiar título')]),
};

const PARTIAL = {
  ...READY,
  software: R('running', ''),
  audio: R('pending', 'No hay ninguna entrada de audio externa conectada (consola, interfaz o micrófono USB). Conéctala; se revisa sola.', [
    { label: 'Fuente “Mic/Aux”', value: 'MacBook Pro (micrófono) · de la computadora', status: 'warn' },
    { label: 'Entradas externas conectadas', value: 'Ninguna' },
  ], [A('retry', 'Reintentar'), A('use-computer', 'Usar el micrófono de la computadora'), A('open-settings', 'Cambiar origen del audio')]),
  lyrics: R('pending', 'Esperando a OBS: ábrelo o usa “Preparar todo”.'),
  cameras: R('pending', '2 de 3 cámaras sin conectar. Se revisan solas cada pocos segundos.', [
    { label: 'Celular 1 · Escenario', value: '“Celular 1 · Escenario” recibe imagen', status: 'ok' },
    { label: 'Celular 2 · Iglesia', value: 'No detectado: conecta el celular y abre la app NDI', status: 'pending' },
    { label: 'Celular 3 · Público', value: 'No detectado: conecta el celular y abre la app NDI', status: 'pending' },
  ], [A('retry', 'Revisar de nuevo', true), A('skip', 'Omitir por ahora')], { previews: [{ label: 'Celular 1 · Escenario', src: frame('#ff8a5c', '#3a1608', 'Celular 1 · Escenario') }] }),
  scenes: R('pending', 'Esperando a OBS: ábrelo o usa “Preparar todo”.'),
};

const SCREEN_READY = {
  presenter: R('ok', 'Holyrics está abierto.', [{ label: 'Ubicación', value: '/Applications/Holyrics.app' }], [A('open-app', 'Traer al frente')]),
  displays: R('ok', '2 pantallas de salida conectadas, escritorio extendido.', [
    { label: 'Monitor del operador', value: '2560 × 1440 · Operador (principal)' },
    { label: 'Epson Projector', value: '1920 × 1080 · Proyector', status: 'ok' },
    { label: 'HDMI TV', value: '1920 × 1080 · Retorno del púlpito', status: 'ok' },
  ], [A('show-pattern', 'Identificar pantallas', true), A('open-display-settings', 'Ajustes de pantalla'), A('retry', 'Reintentar')]),
  identify: R('ok', 'Confirmaste que cada pantalla muestra su imagen.', [], [A('show-pattern', 'Mostrar de nuevo')]),
  output: R('confirm', 'Proyecta algo (una letra o un versículo) y confirma que se ve en la pantalla de salida y no en la tuya.', [], [A('confirm', 'Sale en la pantalla correcta', true), A('open-app', 'Abrir Holyrics')], {
    help: 'En Holyrics abre la configuración de pantallas (proyección) y elige la pantalla de salida que viste en el patrón. Si usas pantalla de retorno, asígnala como pantalla de retorno o escenario.',
  }),
  ndiout: R('ok', 'Confirmaste que la salida NDI está activa.'),
  network: R('ok', 'Red local e internet funcionando.', [{ label: 'Red local', value: '192.168.1.31 (en0)', status: 'ok' }, { label: 'Internet', value: 'Conectado', status: 'ok' }]),
};

let current = TRANSMISSION;
let results = PARTIAL;

ipcMain.handle('app:init', () => ({
  name: 'Kerygma Live', version: '0.1.0', platform: process.platform, hostname: current.computerName,
  settings: current, secrets: { streamKey: true, obsPassword: false }, obsWebsocket: { exists: true, enabled: true, port: 4455 },
  items: checklist(current), setup: setupSummary(current), service: current.mode === 'transmission' ? 'domingo' : serviceFor(current.services)?.id,
}));
ipcMain.handle('settings:save', (_e, patch) => {
  current = settingsSchema.merge(current, settingsSchema.sanitize(patch));
  if (patch.theme) nativeTheme.themeSource = patch.theme;
  return { name: 'Kerygma Live', version: '0.1.0', platform: process.platform, hostname: current.computerName, settings: current, secrets: { streamKey: true }, obsWebsocket: { enabled: true }, items: checklist(current), setup: setupSummary(current), service: 'domingo' };
});
ipcMain.handle('secrets:set', () => ({ streamKey: true, obsPassword: false }));
ipcMain.handle('checks:run', (e, id) => {
  const res = results[id] || R('pending', '');
  e.sender.send('checks:update', { id, result: res });
  return res;
});
ipcMain.handle('checks:prepare', () => null);
ipcMain.handle('checks:action', () => ({ handled: true }));
ipcMain.handle('checks:service', () => null);
ipcMain.handle('checks:reset', () => true);
ipcMain.handle('stream:start', () => ({ ok: true }));
ipcMain.handle('patterns:show', () => {});
ipcMain.handle('obs:scan', () => ({ connected: true, scenes: ['Transmisión', 'Pantalla completa', 'Inicio'], textSources: ['Título'], audioDevices: ['Scarlett 2i2 USB'], ndiInputs: ['Letras', 'Celular 1 · Escenario'], ndiNetwork: ['MAC-PROYECCION (Holyrics)'] }));
ipcMain.handle('shell:openExternal', () => {});

async function shot(win, name) {
  // Fuerza un repintado: con la ventana en segundo plano, capturePage puede devolver el cuadro anterior.
  win.webContents.invalidate();
  await sleep(700);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
  console.log(`✔ ${name}`);
}
const run = (win, code) => win.webContents.executeJavaScript(code);
/** Espera a que exista el elemento (la interfaz se dibuja después de pedir los datos) y le hace clic. */
async function click(win, selector) {
  for (let i = 0; i < 50; i++) {
    if (await run(win, `!!document.querySelector(${JSON.stringify(selector)})`)) {
      await run(win, `document.querySelector(${JSON.stringify(selector)}).click()`);
      return;
    }
    await sleep(100);
  }
  throw new Error(`No apareció ${selector}`);
}
async function waitFor(win, selector) {
  for (let i = 0; i < 50 && !(await run(win, `!!document.querySelector(${JSON.stringify(selector)})`)); i++) await sleep(100);
}
/** Publica todos los resultados de golpe (como si las revisiones ya hubieran corrido). */
const publish = (win) => {
  for (const [id, result] of Object.entries(results)) win.webContents.send('checks:update', { id, result });
};

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  const win = new BrowserWindow({
    width: 1180, height: 800, show: true, backgroundColor: '#0e0e10',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 18, y: 18 } } : { titleBarOverlay: { color: '#0e0e10', symbolColor: '#8e8e98', height: 52 } }),
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });

  // 1. Inicio: elegir el modo de esta computadora
  current = { ...TRANSMISSION, setupDone: false, mode: null };
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await waitFor(win, '[data-mode]');
  await shot(win, '1-inicio.png');

  // 2. Asistente: cámaras (con los datos del equipo ya escritos)
  await click(win, '[data-mode=transmission]');
  await sleep(300);
  for (let i = 0; i < 5; i++) {
    await click(win, '[data-wizard=next]');
    await sleep(120);
  }
  await shot(win, '2-asistente.png');

  // 3. Checklist a medio preparar
  current = TRANSMISSION;
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await waitFor(win, '.check-row');
  await sleep(300);
  publish(win);
  await shot(win, '3-checklist.png');

  // 4. Audio externo con señal  ·  5. Cámaras: una conectada, dos pendientes
  results = { ...PARTIAL, audio: READY.audio };
  publish(win);
  await click(win, '[data-nav="detail:audio"]');
  await shot(win, '4-audio.png');
  await click(win, '[data-nav="detail:cameras"]');
  await shot(win, '5-camaras.png');

  // 6. Todo listo
  results = READY;
  publish(win);
  await click(win, '[data-nav="checklist"]');
  await shot(win, '6-listo.png');

  // 9. Configuración (antes de cambiar de modo)
  await click(win, '[data-nav="settings"]');
  await sleep(300);
  await shot(win, '9-configuracion.png');

  // 10. Tema claro
  await click(win, '[data-chip="theme"][data-value="light"]');
  await click(win, '[data-nav="checklist"]');
  await click(win, '[data-nav="detail:lyrics"]');
  await shot(win, '10-claro.png');
  await run(win, `state.settings.theme = 'dark'`);

  // 7. Modo Pantalla  ·  8. Pantallas conectadas
  current = SCREEN;
  results = SCREEN_READY;
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await waitFor(win, '.check-row');
  await sleep(300);
  publish(win);
  await shot(win, '7-pantalla.png');
  await click(win, '[data-nav="detail:displays"]');
  await shot(win, '8-pantallas.png');

  app.quit();
});
