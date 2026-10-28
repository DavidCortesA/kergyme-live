/**
 * Esquema de la configuración: valores por defecto y validación de lo que llega desde la
 * interfaz. Sin dependencias de Electron (se puede probar con Node).
 *
 * Las claves secretas (clave de transmisión y contraseña de OBS) NO pasan por aquí: el
 * proceso principal las guarda cifradas con el llavero del sistema (ver main.js).
 */

const CHOICES = {
  theme: ['system', 'light', 'dark'],
  mode: ['transmission', 'screen'],
  software: ['obs', 'streamlabs', 'vmix', 'ecamm', 'other'],
  destination: ['facebook', 'youtube', 'custom'],
  browser: ['default', 'safari', 'chrome', 'edge', 'firefox', 'none'],
  audioSource: ['external', 'computer'],
  cameraType: ['ndi', 'capture', 'webcam', 'switcher', 'ip'],
  presenter: ['holyrics', 'propresenter', 'easyworship', 'openlp', 'other'],
  outputRole: ['projector', 'tv', 'receiver', 'stage'],
};

const MAX_CAMERAS = 8;
const MAX_OUTPUTS = 4;
const MAX_SERVICES = 7;

function defaults() {
  return {
    theme: 'dark',
    mode: null, // se elige en la pantalla inicial
    setupDone: false,
    org: '',
    computerName: '',
    transmission: {
      software: 'obs',
      destination: null, // se elige en el asistente
      pageName: '',
      pageUrl: '',
      server: '', // solo para RTMP personalizado
      browser: null, // se elige en el asistente
      bitrateKbps: 6000,
      // external: consola, interfaz o micrófono externo (se revisa que OBS no use el de la computadora)
      // computer: el micrófono de la computadora, a propósito
      audio: { source: 'external', device: '', required: true },
      cameras: [],
      lyrics: { enabled: false, source: '' },
      obs: { host: '127.0.0.1', port: 4455, scene: '', titleSource: '' },
    },
    services: [{ id: 'domingo', name: 'Domingo', weekday: 0, title: '' }],
    screen: {
      software: 'holyrics',
      outputs: [{ id: 'o1', role: 'projector', name: 'Proyector' }],
      ndiOut: false,
      apiPort: 0, // API de red de ProPresenter (0 = no se usa)
    },
  };
}

const pick = (value, allowed) => (allowed.includes(value) ? value : undefined);
const bool = (value) => (typeof value === 'boolean' ? value : undefined);
const text = (value, max = 120) => (typeof value === 'string' ? value.trim().slice(0, max) : undefined);
const int = (value, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};
const set = (obj, key, value) => value !== undefined && (obj[key] = value);
const slug = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);

/** Solo enlaces http(s); evita que la app abra esquemas raros en el navegador. */
function url(value) {
  const s = text(value, 300);
  if (s === undefined) return undefined;
  if (s === '') return '';
  const withScheme = /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function rtmp(value) {
  const s = text(value, 300);
  if (s === undefined || s === '') return s;
  return /^rtmps?:\/\/[^\s]+$/i.test(s) ? s : undefined;
}

function sanitizeCamera(c, i) {
  if (!c || typeof c !== 'object') return null;
  const name = text(c.name, 60);
  const type = pick(c.type, CHOICES.cameraType);
  if (!name || !type) return null;
  return { id: slug(c.id) || `c${i + 1}`, name, type, source: text(c.source, 120) || '' };
}

function sanitizeService(s, i) {
  if (!s || typeof s !== 'object') return null;
  const name = text(s.name, 40);
  if (!name) return null;
  return {
    id: slug(s.id) || slug(name) || `s${i + 1}`,
    name,
    weekday: int(s.weekday, 0, 6) ?? null,
    title: text(s.title, 200) || '',
  };
}

function sanitizeOutput(o, i) {
  if (!o || typeof o !== 'object') return null;
  const role = pick(o.role, CHOICES.outputRole);
  if (!role) return null;
  return { id: slug(o.id) || `o${i + 1}`, role, name: text(o.name, 40) || '' };
}

/** Deja solo los campos válidos de un parche (lo demás se descarta). */
function sanitize(patch = {}) {
  const out = {};
  set(out, 'theme', pick(patch.theme, CHOICES.theme));
  if (patch.mode === null) out.mode = null;
  else set(out, 'mode', pick(patch.mode, CHOICES.mode));
  set(out, 'setupDone', bool(patch.setupDone));
  set(out, 'org', text(patch.org, 80));
  set(out, 'computerName', text(patch.computerName, 60));

  const t = patch.transmission;
  if (t && typeof t === 'object') {
    const o = {};
    set(o, 'software', pick(t.software, CHOICES.software));
    set(o, 'destination', pick(t.destination, CHOICES.destination));
    set(o, 'pageName', text(t.pageName, 80));
    set(o, 'pageUrl', url(t.pageUrl));
    set(o, 'server', rtmp(t.server));
    set(o, 'browser', pick(t.browser, CHOICES.browser));
    set(o, 'bitrateKbps', int(t.bitrateKbps, 500, 50000));
    if (t.audio && typeof t.audio === 'object') {
      o.audio = {};
      // Configuración anterior a 0.2: "builtin" era el micrófono de la computadora.
      set(o.audio, 'source', pick(t.audio.source, CHOICES.audioSource) ?? (t.audio.type === 'builtin' ? 'computer' : t.audio.type ? 'external' : undefined));
      set(o.audio, 'device', text(t.audio.device, 80));
      set(o.audio, 'required', bool(t.audio.required));
    }
    if (Array.isArray(t.cameras)) o.cameras = t.cameras.slice(0, MAX_CAMERAS).map(sanitizeCamera).filter(Boolean);
    if (t.lyrics && typeof t.lyrics === 'object') {
      o.lyrics = {};
      set(o.lyrics, 'enabled', bool(t.lyrics.enabled));
      set(o.lyrics, 'source', text(t.lyrics.source, 120));
    }
    if (t.obs && typeof t.obs === 'object') {
      o.obs = {};
      set(o.obs, 'host', text(t.obs.host, 120));
      set(o.obs, 'port', int(t.obs.port, 1, 65535));
      set(o.obs, 'scene', text(t.obs.scene, 120));
      set(o.obs, 'titleSource', text(t.obs.titleSource, 120));
    }
    out.transmission = o;
  }

  if (Array.isArray(patch.services)) {
    out.services = patch.services.slice(0, MAX_SERVICES).map(sanitizeService).filter(Boolean);
  }

  const s = patch.screen;
  if (s && typeof s === 'object') {
    const o = {};
    set(o, 'software', pick(s.software, CHOICES.presenter));
    if (Array.isArray(s.outputs)) o.outputs = s.outputs.slice(0, MAX_OUTPUTS).map(sanitizeOutput).filter(Boolean);
    set(o, 'ndiOut', bool(s.ndiOut));
    set(o, 'apiPort', int(s.apiPort, 0, 65535));
    out.screen = o;
  }
  return out;
}

function merge(current, patch) {
  const t = current.transmission;
  const p = patch.transmission || {};
  return {
    ...current,
    ...patch,
    transmission: {
      ...t,
      ...p,
      audio: { ...t.audio, ...p.audio },
      lyrics: { ...t.lyrics, ...p.lyrics },
      obs: { ...t.obs, ...p.obs },
    },
    screen: { ...current.screen, ...patch.screen },
  };
}

/** Lo guardado en disco, validado y completado con los valores de fábrica. */
const effective = (stored) => merge(defaults(), sanitize(stored));

module.exports = { CHOICES, defaults, sanitize, merge, effective };
