/**
 * Revisa en qué página está el navegador y la cambia si hace falta.
 *
 * En macOS se usa AppleScript (Safari, Chrome y Edge lo admiten). La primera vez macOS
 * pregunta si Kerygma Live puede controlar el navegador (Privacidad y seguridad → Automatización).
 * Firefox y Windows no permiten leer la pestaña: ahí la app abre la página y pide confirmar.
 */
const { execFile } = require('child_process');

const SCRIPTABLE = {
  safari: { app: 'Safari', tab: 'current tab' },
  chrome: { app: 'Google Chrome', tab: 'active tab' },
  edge: { app: 'Microsoft Edge', tab: 'active tab' },
};

const canRead = (browser, platform = process.platform) => platform === 'darwin' && !!SCRIPTABLE[browser];

/** Error -1743: el usuario no ha dado permiso de Automatización. */
const NOT_AUTHORIZED = /-1743|not authorized|no autorizad/i;

function osascript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(String(stderr || err.message).trim());
        e.code = NOT_AUTHORIZED.test(stderr || '') ? 'NOT_AUTHORIZED' : 'SCRIPT_FAILED';
        reject(e);
      } else resolve(String(stdout).trim());
    });
  });
}

/** Comillas seguras para AppleScript. */
const asString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** URL de la pestaña al frente, o '' si no hay ventanas. Llamar solo con el navegador abierto. */
function currentUrl(browser) {
  const b = SCRIPTABLE[browser];
  return osascript(`tell application ${asString(b.app)}
  if (count of windows) is 0 then return ""
  return URL of ${b.tab} of front window
end tell`);
}

/** Lleva la pestaña al frente a `url` (o abre una ventana si no hay). */
function goTo(browser, url) {
  const b = SCRIPTABLE[browser];
  return osascript(`tell application ${asString(b.app)}
  activate
  if (count of windows) is 0 then
    make new document
  end if
  set URL of ${b.tab} of front window to ${asString(url)}
end tell`);
}

/**
 * ¿La dirección corresponde a la página configurada?
 * Facebook: misma página (primer segmento de la ruta, sin distinguir mayúsculas) o el
 * Productor en vivo (/live/producer), desde donde se transmite como la página.
 * YouTube: YouTube Studio o el canal configurado.
 */
function pageMatches(current, pageUrl, destination) {
  let cur;
  try {
    cur = new URL(current);
  } catch {
    return { ok: false, reason: 'Sin página abierta' };
  }
  const host = cur.hostname.replace(/^(www|m|web)\./, '');
  const seg = (u) => decodeURIComponent(u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();

  if (destination === 'facebook') {
    if (host !== 'facebook.com' && host !== 'business.facebook.com') return { ok: false, reason: 'No está en Facebook' };
    if (cur.pathname.startsWith('/live/producer')) return { ok: true, where: 'producer' };
    if (!pageUrl) return { ok: true, where: 'facebook' };
    let page;
    try {
      page = new URL(pageUrl);
    } catch {
      return { ok: true, where: 'facebook' };
    }
    // facebook.com/profile.php?id=123 → se compara el id
    if (seg(page) === 'profile.php') {
      return cur.searchParams.get('id') === page.searchParams.get('id') ? { ok: true, where: 'page' } : { ok: false, reason: 'Está en otra página de Facebook' };
    }
    return seg(cur) === seg(page) ? { ok: true, where: 'page' } : { ok: false, reason: 'Está en otra página de Facebook' };
  }
  if (destination === 'youtube') {
    if (host === 'studio.youtube.com') return { ok: true, where: 'studio' };
    if (host !== 'youtube.com') return { ok: false, reason: 'No está en YouTube' };
    if (!pageUrl) return { ok: true, where: 'youtube' };
    try {
      return seg(cur) === seg(new URL(pageUrl)) ? { ok: true, where: 'channel' } : { ok: false, reason: 'Está en otro canal de YouTube' };
    } catch {
      return { ok: true, where: 'youtube' };
    }
  }
  if (!pageUrl) return { ok: true, where: 'any' };
  try {
    return cur.hostname === new URL(pageUrl).hostname ? { ok: true, where: 'page' } : { ok: false, reason: 'Está en otro sitio' };
  } catch {
    return { ok: true, where: 'any' };
  }
}

/** Página que se abre para transmitir en cada destino. */
function livePageFor(destination, pageUrl) {
  if (destination === 'facebook') return 'https://www.facebook.com/live/producer/';
  if (destination === 'youtube') return 'https://studio.youtube.com/';
  return pageUrl || '';
}

module.exports = { SCRIPTABLE, canRead, currentUrl, goTo, pageMatches, livePageFor };
