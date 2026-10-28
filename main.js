const { app, BrowserWindow, ipcMain, shell, Menu, nativeTheme, clipboard, nativeImage, screen, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const settingsSchema = require('./src/core/settings');
const { checklist, summarize, serviceFor } = require('./src/core/checklist');
const obsConfig = require('./src/core/obs-config');
const obsApi = require('./src/core/obs');
const checks = require('./src/main/checks');

const APP_NAME = 'Kerygma Live';
const IS_MAC = process.platform === 'darwin';

/* ------------------------------------------------------------------ */
/* Configuración y claves                                              */
/* ------------------------------------------------------------------ */
const dataFile = (name) => path.join(app.getPath('userData'), name);

function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(dataFile(name), 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(name, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(dataFile(name), JSON.stringify(data, null, 2));
}

const loadSettings = () => settingsSchema.effective(readJson('settings.json'));

function saveSettings(patch) {
  const before = loadSettings();
  const next = settingsSchema.merge(before, settingsSchema.sanitize(patch));
  writeJson('settings.json', next);
  nativeTheme.themeSource = next.theme;
  // Al cambiar de modo o de equipo, lo confirmado ya no vale.
  if (before.mode !== next.mode) resetSession();
  return loadSettings();
}

/**
 * Clave de transmisión y contraseña de OBS: cifradas con el llavero del sistema
 * (Llavero de macOS / DPAPI de Windows). Nunca viajan a la interfaz.
 */
const SECRET_NAMES = ['streamKey', 'obsPassword'];
const secrets = {
  get(name) {
    const enc = readJson('secrets.json')[name];
    if (!enc || !safeStorage.isEncryptionAvailable()) return '';
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return '';
    }
  },
  set(name, value) {
    if (!SECRET_NAMES.includes(name)) throw new Error('Clave desconocida');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('El sistema no permite guardar claves cifradas.');
    const all = readJson('secrets.json');
    const clean = String(value || '').trim();
    if (clean) all[name] = safeStorage.encryptString(clean).toString('base64');
    else delete all[name];
    writeJson('secrets.json', all);
  },
  status: () => Object.fromEntries(SECRET_NAMES.map((n) => [n, !!readJson('secrets.json')[n]])),
};

/* ------------------------------------------------------------------ */
/* Sesión: lo que se confirmó u omitió desde que se abrió la app        */
/* ------------------------------------------------------------------ */
let session;
function resetSession() {
  session = { confirmed: new Set(), skipped: new Set(), speed: null, obsInfo: null, audioLevel: null, serviceId: null, results: {} };
}
resetSession();

let mainWindow = null;
let patternWindows = [];

function context(settings, { auto = false, devices = null } = {}) {
  return {
    settings,
    auto,
    devices,
    secrets,
    state: session,
    electron: { screen, nativeImage, clipboard, shell },
    showPatterns,
  };
}

const send = (channel, payload) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send(channel, payload);

async function runCheck(id, opts = {}) {
  const settings = loadSettings();
  send('checks:update', { id, result: { status: 'running', message: '', details: [], actions: [] } });
  const res = await checks.run(id, context(settings, opts), opts);
  session.results[id] = res;
  send('checks:update', { id, result: res });
  return res;
}

let preparing = false;

/** "Preparar todo": cada revisión en orden, abriendo y configurando lo que se pueda. */
async function prepareAll(devices) {
  if (preparing) return null;
  preparing = true;
  try {
    const settings = loadSettings();
    for (const item of checklist(settings)) {
      await runCheck(item.id, { auto: true, devices });
    }
    return summarize(checklist(settings), session.results);
  } finally {
    preparing = false;
  }
}

/* ------------------------------------------------------------------ */
/* Patrón de prueba en cada pantalla                                   */
/* ------------------------------------------------------------------ */
function closePatterns() {
  for (const w of patternWindows) if (!w.isDestroyed()) w.close();
  patternWindows = [];
}

function showPatterns() {
  closePatterns();
  const settings = loadSettings();
  const all = checks.currentDisplays(context(settings));
  const outputs = settings.screen.outputs;
  const ROLE = { projector: 'Proyector', tv: 'Pantalla o TV', receiver: 'Receptor inalámbrico', stage: 'Pantalla de retorno' };
  const extra = all.filter((d) => !d.primary);
  const targets = extra.length ? extra : all; // sin pantallas extra, se muestra en la principal para que se vea qué pasa

  targets.forEach((d, i) => {
    const out = d.primary ? null : outputs[extra.indexOf(d)];
    const label = d.primary ? 'Pantalla principal (operador)' : out ? out.name || ROLE[out.role] : 'Pantalla extra';
    const win = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, show: false, backgroundColor: '#0e0e10', alwaysOnTop: true, skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setBounds(d.bounds);
    win.loadFile(path.join(__dirname, 'src', 'renderer', 'pattern.html'), {
      query: { n: String(all.indexOf(d) + 1), label, res: `${d.width} × ${d.height}`, total: String(all.length) },
    });
    win.once('ready-to-show', () => {
      win.showInactive();
      // En macOS, la pantalla completa "simple" tapa también la barra de menú (que aparece en cada
      // pantalla) sin la animación de cambiar de escritorio; así se ven las cuatro esquinas.
      if (IS_MAC) win.setSimpleFullScreen(true);
      else win.setFullScreen(true);
    });
    win.webContents.on('before-input-event', (_e, input) => input.key === 'Escape' && closePatterns());
    win.webContents.on('will-navigate', (e) => {
      e.preventDefault();
      closePatterns();
    });
    patternWindows.push(win);
  });
  setTimeout(closePatterns, 15000);
}

/* ------------------------------------------------------------------ */
/* Ventana                                                              */
/* ------------------------------------------------------------------ */
const TITLEBAR = {
  dark: { color: '#0e0e10', symbolColor: '#f4f4f5' },
  light: { color: '#f5f5f6', symbolColor: '#17171a' },
};
const titlebarColors = () => TITLEBAR[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];

nativeTheme.on('updated', () => {
  if (!mainWindow) return;
  mainWindow.setBackgroundColor(titlebarColors().color);
  if (!IS_MAC) mainWindow.setTitleBarOverlay({ ...titlebarColors(), height: 52 });
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 980,
    minHeight: 660,
    title: APP_NAME,
    backgroundColor: titlebarColors().color,
    icon: path.join(__dirname, 'src', 'renderer', 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    ...(IS_MAC ? { trafficLightPosition: { x: 18, y: 18 } } : { titleBarOverlay: { ...titlebarColors(), height: 52 } }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.on('closed', () => {
    mainWindow = null;
    closePatterns();
  });
}

function buildMenu() {
  const template = [
    ...(IS_MAC
      ? [{ label: APP_NAME, submenu: [{ role: 'about', label: `Acerca de ${APP_NAME}` }, { type: 'separator' }, { role: 'hide', label: 'Ocultar' }, { role: 'quit', label: 'Salir' }] }]
      : []),
    {
      label: 'Edición',
      submenu: [
        { role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' }, { type: 'separator' },
        { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' },
      ],
    },
    { label: 'Ventana', submenu: [{ role: 'minimize', label: 'Minimizar' }, { role: 'close', label: 'Cerrar' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* IPC                                                                  */
/* ------------------------------------------------------------------ */
function initPayload() {
  const settings = loadSettings();
  const ws = obsConfig.readWebsocket();
  return {
    name: APP_NAME,
    version: app.getVersion(),
    platform: process.platform,
    hostname: os.hostname().replace(/\.local$/, ''),
    settings,
    secrets: secrets.status(),
    obsWebsocket: { exists: ws.exists, enabled: ws.enabled, port: ws.port },
    items: checklist(settings),
    service: serviceFor(settings.services)?.id || null,
  };
}

ipcMain.handle('app:init', () => initPayload());

ipcMain.handle('settings:save', (_e, patch) => {
  saveSettings(patch);
  return initPayload();
});

ipcMain.handle('secrets:set', (_e, name, value) => {
  secrets.set(name, value);
  if (name === 'obsPassword') checks.obs.close();
  return secrets.status();
});

ipcMain.handle('checks:run', (_e, id, opts = {}) => runCheck(id, { devices: opts.devices, light: !!opts.light }));
ipcMain.handle('checks:prepare', (_e, devices) => prepareAll(devices));

ipcMain.handle('checks:action', async (_e, id, actionId, devices) => {
  const settings = loadSettings();
  try {
    const again = await checks.act(id, actionId, context(settings, { devices }));
    if (again) return runCheck(id, { devices });
    return { handled: true };
  } catch (err) {
    return { error: err.message || String(err) };
  }
});

ipcMain.handle('checks:service', (_e, serviceId) => {
  session.serviceId = serviceId;
  return runCheck('title');
});

ipcMain.handle('checks:reset', () => {
  resetSession();
  return true;
});

ipcMain.handle('stream:start', async () => {
  try {
    await checks.startStream(context(loadSettings()));
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('patterns:show', () => showPatterns());
ipcMain.handle('patterns:close', () => closePatterns());

/** Datos de OBS para llenar listas en Configuración (escenas, fuentes de texto, audio, NDI). */
ipcMain.handle('obs:scan', async () => {
  const settings = loadSettings();
  try {
    await checks.run('software', context(settings), { light: true });
    const o = checks.obs;
    if (!o.connected) return { connected: false };
    const { scenes } = await o.request('GetSceneList');
    const { inputs } = await o.request('GetInputList');
    const audio = await obsApi.audioInputs(o);
    const audioDevices = audio.length ? await obsApi.audioDevices(o, audio[0].inputName) : [];
    const ndi = await obsApi.ndiInputs(o);
    const ndiNetwork = ndi.length ? await obsApi.ndiNetworkSources(o, ndi[0].inputName) : [];
    return {
      connected: true,
      scenes: scenes.map((s) => s.sceneName).reverse(), // OBS las devuelve de abajo hacia arriba
      textSources: inputs.filter((i) => obsApi.TEXT_KINDS.includes(i.inputKind)).map((i) => i.inputName),
      audioDevices: audioDevices.map((d) => d.name),
      ndiNetwork,
    };
  } catch (err) {
    return { connected: false, error: err.message };
  }
});

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});

/* ------------------------------------------------------------------ */
/* Arranque                                                             */
/* ------------------------------------------------------------------ */
app.setName(APP_NAME);
app.whenReady().then(() => {
  nativeTheme.themeSource = loadSettings().theme;
  buildMenu();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  checks.obs.close();
  app.quit();
});
