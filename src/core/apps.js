/**
 * Programas que la app sabe encontrar, abrir y vigilar en macOS y Windows.
 *
 *   mac.names    nombre del .app (se busca en /Applications y ~/Applications, y luego con Spotlight)
 *   mac.bundle   identificador del paquete, para Spotlight
 *   win.paths    rutas típicas del ejecutable (%VARIABLES% de entorno permitidas)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const CATALOG = {
  obs: {
    name: 'OBS Studio',
    mac: { names: ['OBS'], bundle: 'com.obsproject.obs-studio' },
    win: { paths: ['%ProgramFiles%\\obs-studio\\bin\\64bit\\obs64.exe'] },
    url: 'https://obsproject.com/es/download',
  },
  streamlabs: {
    name: 'Streamlabs Desktop',
    mac: { names: ['Streamlabs Desktop', 'Streamlabs OBS'], bundle: 'com.streamlabs.slobs' },
    win: { paths: ['%ProgramFiles%\\Streamlabs OBS\\Streamlabs OBS.exe', '%LOCALAPPDATA%\\Programs\\streamlabs-desktop\\Streamlabs Desktop.exe'] },
    url: 'https://streamlabs.com/streamlabs-live-streaming-software',
  },
  vmix: {
    name: 'vMix',
    win: { paths: ['%ProgramFiles(x86)%\\vMix\\vMix64.exe', '%ProgramFiles%\\vMix\\vMix64.exe'] },
    url: 'https://www.vmix.com/software/download.aspx',
  },
  ecamm: {
    name: 'Ecamm Live',
    mac: { names: ['Ecamm Live'], bundle: 'com.ecamm.EcammLive' },
    url: 'https://www.ecamm.com/mac/ecammlive/',
  },
  holyrics: {
    name: 'Holyrics',
    mac: { names: ['Holyrics'] },
    win: { paths: ['%ProgramFiles%\\Holyrics\\Holyrics.exe', '%ProgramFiles(x86)%\\Holyrics\\Holyrics.exe', 'C:\\Holyrics\\Holyrics.exe', '%LOCALAPPDATA%\\Holyrics\\Holyrics.exe'] },
    url: 'https://www.holyrics.com.br/download.html',
  },
  propresenter: {
    name: 'ProPresenter',
    mac: { names: ['ProPresenter', 'ProPresenter 7'], bundle: 'com.renewedvision.propresenter' },
    win: { paths: ['%ProgramFiles%\\Renewed Vision\\ProPresenter\\ProPresenter.exe', '%ProgramFiles%\\Renewed Vision\\ProPresenter 7\\ProPresenter.exe'] },
    url: 'https://renewedvision.com/propresenter/download/',
  },
  easyworship: {
    name: 'EasyWorship',
    win: { paths: ['%ProgramFiles(x86)%\\Softouch\\EasyWorship 7\\EasyWorship.exe', '%ProgramFiles%\\Softouch\\EasyWorship 7\\EasyWorship.exe', '%ProgramFiles(x86)%\\Softouch\\Easyworship 6\\EasyWorship.exe'] },
    url: 'https://easyworship.com/download',
  },
  openlp: {
    name: 'OpenLP',
    mac: { names: ['OpenLP'], bundle: 'org.openlp.OpenLP' },
    win: { paths: ['%ProgramFiles%\\OpenLP\\OpenLP.exe', '%ProgramFiles(x86)%\\OpenLP\\OpenLP.exe'] },
    url: 'https://openlp.org/#downloads',
  },
  safari: { name: 'Safari', mac: { names: ['Safari'], bundle: 'com.apple.Safari' } },
  chrome: {
    name: 'Google Chrome',
    mac: { names: ['Google Chrome'], bundle: 'com.google.Chrome' },
    win: { paths: ['%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe', '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe', '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe'] },
  },
  edge: {
    name: 'Microsoft Edge',
    mac: { names: ['Microsoft Edge'], bundle: 'com.microsoft.edgemac' },
    win: { paths: ['%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe', '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe'] },
  },
  firefox: {
    name: 'Firefox',
    mac: { names: ['Firefox'], bundle: 'org.mozilla.firefox' },
    win: { paths: ['%ProgramFiles%\\Mozilla Firefox\\firefox.exe', '%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe'] },
  },
};

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true, ...opts }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
  });

const expandEnv = (p, env = process.env) => p.replace(/%([^%]+)%/g, (_, k) => env[k] || env[k.toUpperCase()] || `%${k}%`);

/** Ruta del programa instalado, o null. */
async function locate(id, platform = process.platform) {
  const entry = CATALOG[id];
  if (!entry) return null;
  if (platform === 'darwin' && entry.mac) {
    for (const dir of ['/Applications', path.join(os.homedir(), 'Applications'), '/System/Applications', '/System/Volumes/Preboot/Cryptexes/App/System/Applications']) {
      for (const name of entry.mac.names) {
        const p = path.join(dir, `${name}.app`);
        if (fs.existsSync(p)) return p;
      }
    }
    if (entry.mac.bundle) {
      const { out } = await run('mdfind', [`kMDItemCFBundleIdentifier == '${entry.mac.bundle}'`]);
      const hit = out.split('\n').find((l) => l.endsWith('.app'));
      if (hit) return hit;
    }
    return null;
  }
  if (platform === 'win32' && entry.win) {
    for (const p of entry.win.paths.map((x) => expandEnv(x))) if (fs.existsSync(p)) return p;
  }
  return null;
}

/** ¿Está abierto? (se busca el ejecutable dentro del .app, o el .exe en la lista de procesos). */
async function isRunning(id, appPath, platform = process.platform) {
  if (!appPath) return false;
  if (platform === 'darwin') {
    // Por nombre del .app y no por ruta completa: Safari, por ejemplo, corre desde
    // /System/Volumes/Preboot/Cryptexes/... aunque se encuentre en /Applications.
    const { ok } = await run('pgrep', ['-f', `/${path.basename(appPath)}/Contents/MacOS/`]);
    return ok;
  }
  if (platform === 'win32') {
    const exe = path.win32.basename(appPath);
    const { out } = await run('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/NH']);
    return out.toLowerCase().includes(exe.toLowerCase());
  }
  return false;
}

/** Abre el programa (o lo trae al frente si ya está abierto); con `url`, la abre en él. */
async function open(appPath, url, platform = process.platform) {
  if (platform === 'darwin') {
    const { ok } = await run('open', url ? ['-a', appPath, url] : ['-a', appPath]);
    return ok;
  }
  if (platform === 'win32') {
    // OBS y otros buscan sus archivos relativos a la carpeta del ejecutable.
    const child = spawn(appPath, url ? [url] : [], { cwd: path.win32.dirname(appPath), detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  }
  return false;
}

/** Estado de un programa: { id, name, path, installed, running }. */
async function status(id) {
  const appPath = await locate(id);
  return { id, name: CATALOG[id]?.name || id, path: appPath, installed: !!appPath, running: await isRunning(id, appPath), url: CATALOG[id]?.url || '' };
}

/** Espera a que el programa aparezca abierto (hasta `ms`). */
async function waitRunning(id, appPath, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await isRunning(id, appPath)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

module.exports = { CATALOG, expandEnv, locate, isRunning, open, status, waitRunning, run };
