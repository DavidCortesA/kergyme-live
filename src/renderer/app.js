/* ============================================================
   Kerygma Live — interfaz
   Pantalla inicial (modo) → asistente de configuración → checklist con detalle de cada revisión.
   ============================================================ */
const api = window.kerygma;
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const clone = (o) => JSON.parse(JSON.stringify(o));

const STATUS_TEXT = { pending: 'Pendiente', running: 'Revisando…', ok: 'Completado', warn: 'Atención', error: 'Revisar', confirm: 'Confirmar', skipped: 'Omitido' };
const STATUS_ICON = { ok: 'check-circle', warn: 'alert', error: 'alert', pending: 'info', confirm: 'info', running: 'info', skipped: 'info' };
const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const OPTIONS = {
  software: [
    ['obs', 'OBS Studio', 'Revisión y configuración automática'],
    ['streamlabs', 'Streamlabs'],
    ['vmix', 'vMix', null, 'win32'],
    ['ecamm', 'Ecamm Live', null, 'darwin'],
    ['other', 'Otro'],
  ],
  destination: [['facebook', 'Facebook Live'], ['youtube', 'YouTube Live'], ['custom', 'Servidor RTMP']],
  browser: [['safari', 'Safari', null, 'darwin'], ['chrome', 'Google Chrome'], ['edge', 'Microsoft Edge'], ['firefox', 'Firefox'], ['none', 'Ninguno']],
  audioType: [
    ['usb-console', 'Consola o interfaz USB', 'MAONO, Focusrite, Behringer…'],
    ['mixer', 'Mezcladora digital', 'XR18, X32, Yamaha…'],
    ['usb-mic', 'Micrófono USB'],
    ['hdmi', 'Audio de la capturadora'],
    ['builtin', 'Micrófono de la computadora'],
  ],
  cameraType: [
    ['ndi', 'Celular por NDI'],
    ['capture', 'Capturadora HDMI'],
    ['webcam', 'Cámara USB'],
    ['switcher', 'Switcher / módulo de cámaras'],
    ['ip', 'Cámara PTZ / IP (NDI)'],
  ],
  presenter: [['holyrics', 'Holyrics'], ['propresenter', 'ProPresenter'], ['easyworship', 'EasyWorship', null, 'win32'], ['openlp', 'OpenLP'], ['other', 'Otro']],
  outputRole: [['projector', 'Proyector'], ['tv', 'Pantalla o TV'], ['receiver', 'Receptor inalámbrico'], ['stage', 'Pantalla de retorno']],
  theme: [['dark', 'Oscuro'], ['light', 'Claro'], ['system', 'Sistema']],
};

const CAMERA_HINT = {
  ndi: 'Nombre del celular en la app NDI (ej. iPhone de Juan)',
  capture: 'Nombre de la capturadora (ej. Cam Link, USB Video)',
  webcam: 'Nombre de la cámara (ej. OBSBOT, Logitech)',
  switcher: 'Nombre del switcher (ej. ATEM Mini)',
  ip: 'Nombre NDI de la cámara (ej. PTZOptics)',
};

const state = {
  info: null,
  settings: null,
  items: [],
  results: {},
  view: 'home', // home · wizard · checklist · detail · settings
  detail: null,
  draft: null,
  step: 0,
  secretDraft: {},
  devices: { audioinput: [], videoinput: [] },
  preparing: false,
  obsScan: null,
  service: null,
};

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, p, value) {
  const keys = p.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

function toast(text, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'error' ? 'alert' : 'check-circle')}<span>${esc(text)}</span>`;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6500 : 3500);
}

function applyTheme() {
  const t = state.settings?.theme || 'dark';
  const dark = t === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : t === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

function tickClock() {
  const now = new Date();
  const date = now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  const time = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  $('#clock').innerHTML = `${esc(date.charAt(0).toUpperCase() + date.slice(1))}<b>${esc(time)}</b>`;
}

const options = (key) => OPTIONS[key].filter(([, , , os]) => !os || os === state.info.platform);

/** Dispositivos de audio y video que ve el sistema (para sugerir nombres y para las revisiones). */
async function refreshDevices() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const names = (kind) => [...new Set(list.filter((d) => d.kind === kind && d.label).map((d) => d.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '')))];
    state.devices = { audioinput: names('audioinput'), videoinput: names('videoinput') };
  } catch {
    /* sin acceso: las revisiones usan lo que reporta el sistema */
  }
}
navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);

const serviceById = (id) => state.settings.services.find((s) => s.id === id);
const serviceTitle = (s) => (s ? s.title || (state.settings.org ? `${s.name} | ${state.settings.org}` : s.name) : '');

/* ------------------------------------------------------------------ */
/* Campos de formulario reutilizables (asistente y configuración)      */
/* ------------------------------------------------------------------ */
function chips(path, key, current) {
  return `<div class="chips">${options(key)
    .map(([v, label, sub]) => `<button type="button" class="chip ${current === v ? 'on' : ''}" data-chip="${path}" data-value="${v}">${esc(label)}${sub ? ` <small>${esc(sub)}</small>` : ''}</button>`)
    .join('')}</div>`;
}

function select(attrs, key, current) {
  return `<select class="input" ${attrs}>${options(key).map(([v, label]) => `<option value="${v}" ${current === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
}

const input = (path, value, placeholder = '', extra = '') =>
  `<input class="input" data-input="${path}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false" ${extra} />`;

const toggle = (path, on, title, sub) =>
  `<div class="switch"><div><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div><button type="button" class="toggle ${on ? 'on' : ''}" data-toggle="${path}" aria-pressed="${on}"></button></div>`;

const field = (label, body, note = '') => `<div class="field"><span class="field-label">${esc(label)}</span>${body}${note ? `<p class="note">${note}</p>` : ''}</div>`;

const datalist = (id, values) => `<datalist id="${id}">${[...new Set(values)].map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;

function secretField(name, label, placeholder, note) {
  const saved = state.info.secrets[name];
  return field(
    label,
    `<div class="input-row"><input class="input" type="password" data-secret="${name}" value="${esc(state.secretDraft[name] || '')}" placeholder="${saved ? 'Guardada · escribe para cambiarla' : esc(placeholder)}" autocomplete="off" spellcheck="false" />
      ${saved ? `<button type="button" class="btn sm ghost" data-clear-secret="${name}">${icon('trash', 'sm')} Borrar</button>` : ''}</div>`,
    `${saved ? `<span style="color:var(--ok)">✓ Guardada cifrada en el llavero del sistema.</span> ` : ''}${note}`
  );
}

/* Secciones (cada una es un paso del asistente y un bloque de Configuración) */
const SECTIONS = {
  team: {
    title: 'Tu equipo',
    lead: 'Para los títulos del servicio y para reconocer esta computadora.',
    render: (d) =>
      field('Iglesia u organización', input('org', d.org, 'Montaña de Dios')) +
      field('Nombre de esta computadora', input('computerName', d.computerName, state.info.hostname), 'Ayuda a saber cuál es cuál cuando hay varias.'),
  },
  software: {
    title: 'Programa de transmisión',
    lead: 'Con OBS Studio la app revisa y configura todo sola por WebSocket. Con otros programas los abre y te guía con confirmaciones.',
    render: (d) => {
      const ws = state.info.obsWebsocket;
      const note = d.transmission.software === 'obs'
        ? `El servidor WebSocket de OBS está <b>${ws.enabled ? 'activado' : 'apagado'}</b>.${ws.enabled ? ' La app usa la contraseña de OBS automáticamente.' : ' Al preparar, la app lo activa sola antes de abrir OBS.'}`
        : '';
      return field('Programa', chips('transmission.software', 'software', d.transmission.software), note);
    },
  },
  destination: {
    title: 'Dónde transmiten',
    lead: 'La app abre la página correcta, revisa que estés en ella y pone la clave en OBS.',
    render: (d) => {
      const t = d.transmission;
      const keyHelp = t.destination === 'facebook'
        ? 'En Facebook: Productor en vivo → <b>Clave de transmisión persistente</b> → Copiar. Así no cambia cada domingo.'
        : t.destination === 'youtube' ? 'En YouTube Studio: Transmitir → Clave de transmisión (elige una clave reutilizable).' : 'La que te dio tu servidor de transmisión.';
      return (
        field('Destino', chips('transmission.destination', 'destination', t.destination)) +
        field(t.destination === 'youtube' ? 'Nombre del canal' : 'Nombre de la página', input('transmission.pageName', t.pageName, 'Montaña de Dios')) +
        field(t.destination === 'youtube' ? 'Enlace del canal' : 'Enlace de la página', input('transmission.pageUrl', t.pageUrl, t.destination === 'youtube' ? 'youtube.com/@MontanadeDios' : 'facebook.com/MontanadeDios'),
          'Se usa para revisar que el navegador esté en la página correcta.') +
        (t.destination === 'custom' ? field('Servidor RTMP', input('transmission.server', t.server, 'rtmp://servidor/live')) : '') +
        (t.software === 'obs' ? secretField('streamKey', 'Clave de transmisión', 'Pega aquí la clave', keyHelp) : '') +
        (t.software === 'obs' ? field('Bitrate de video (kbps)', input('transmission.bitrateKbps', t.bitrateKbps, '6000', 'data-num inputmode="numeric"'), 'Se compara con la velocidad de subida. Facebook recomienda hasta 6000 kbps para 1080p.') : '')
      );
    },
  },
  browser: {
    title: 'Navegador',
    lead: 'Dónde se abre la página de transmisión.',
    render: (d) => field('Navegador', chips('transmission.browser', 'browser', d.transmission.browser),
      state.info.platform === 'darwin' ? 'Con Safari, Chrome o Edge la app revisa sola en qué página estás (macOS pedirá permiso de Automatización la primera vez).' : 'En Windows la app abre la página y te pide confirmar que es la correcta.'),
  },
  audio: {
    title: 'Audio',
    lead: 'De dónde entra el sonido. La app revisa que OBS lo tome de ahí y no del micrófono de la computadora.',
    render: (d) => {
      const a = d.transmission.audio;
      const sugg = [...state.devices.audioinput, ...(state.obsScan?.audioDevices || [])];
      return (
        field('Tipo de entrada', chips('transmission.audio.type', 'audioType', a.type)) +
        (a.type !== 'builtin'
          ? field('Nombre del dispositivo', `${input('transmission.audio.device', a.device, 'MAONO', 'list="dl-audio"')}${datalist('dl-audio', sugg)}`,
            'Basta con una parte del nombre, como aparece en el sistema (ej. <b>MAONO</b>).')
          : '') +
        `<div class="field">${toggle('transmission.audio.required', a.required, 'El audio es obligatorio para empezar', 'Si lo apagas, la falta de audio no bloquea el checklist (por ejemplo, si la consola se conecta al final).')}</div>`
      );
    },
  },
  cameras: {
    title: 'Cámaras',
    lead: 'Agrega cada cámara. Las de NDI (celulares, PTZ) se revisan en OBS; las de cable, en la computadora y en OBS.',
    render: (d) => {
      const t = d.transmission;
      const rows = t.cameras
        .map((c, i) => `<div class="list-row" style="grid-template-columns: 1fr 1.1fr 1.4fr 34px">
            <input class="input" data-list="transmission.cameras" data-index="${i}" data-key="name" value="${esc(c.name)}" placeholder="Nombre (ej. Celular 1 · Escenario)" />
            ${select(`data-list="transmission.cameras" data-index="${i}" data-key="type"`, 'cameraType', c.type)}
            <input class="input" data-list="transmission.cameras" data-index="${i}" data-key="source" value="${esc(c.source)}" placeholder="${esc(CAMERA_HINT[c.type])}" list="dl-cam-${c.type === 'ndi' || c.type === 'ip' ? 'ndi' : 'video'}" />
            <button type="button" class="icon-btn" data-remove="transmission.cameras" data-index="${i}" title="Quitar">${icon('trash')}</button>
          </div>`)
        .join('');
      const add = options('cameraType').map(([v, label]) => `<button type="button" class="chip" data-add-camera="${v}">${icon('plus', 'sm')} ${esc(label)}</button>`).join('');
      return (
        field('Cámaras', `<div class="list-editor">${rows || '<p class="note">Sin cámaras todavía.</p>'}</div>
          ${datalist('dl-cam-ndi', [...(state.obsScan?.ndiInputs || []), ...(state.obsScan?.ndiNetwork || [])])}${datalist('dl-cam-video', state.devices.videoinput)}`,
          state.obsScan?.ndiInputs?.length ? `Fuentes NDI en OBS: ${state.obsScan.ndiInputs.map(esc).join(', ')}. Escribe el nombre de la fuente o del emisor.` : '') +
        field('Agregar', `<div class="chips">${add}</div>`, 'Si usas un switcher (ATEM u otro módulo de cámaras), agrégalo como una sola cámara: llega a la computadora por USB.') +
        `<div class="field">${toggle('transmission.lyrics.enabled', t.lyrics.enabled, 'Letras y versículos por NDI', 'Holyrics o ProPresenter en otra computadora envían las letras a OBS por NDI.')}</div>` +
        (t.lyrics.enabled ? field('Nombre del emisor NDI de letras', `${input('transmission.lyrics.source', t.lyrics.source, 'Holyrics', 'list="dl-cam-ndi"')}`, 'Basta con una parte del nombre, como aparece en la lista de NDI de OBS.') : '')
      );
    },
  },
  services: {
    title: 'Servicios y títulos',
    lead: 'Cada reunión con su título. La app elige el del día y lo pone en OBS y en el portapapeles para pegarlo en Facebook.',
    render: (d) => {
      const rows = d.services
        .map((s, i) => `<div class="list-row" style="grid-template-columns: 1fr 1fr 2.2fr 34px">
            <input class="input" data-list="services" data-index="${i}" data-key="name" value="${esc(s.name)}" placeholder="Nombre" />
            <select class="input" data-list="services" data-index="${i}" data-key="weekday" data-num>
              <option value="">Sin día fijo</option>${WEEKDAYS.map((w, n) => `<option value="${n}" ${s.weekday === n ? 'selected' : ''}>${w}</option>`).join('')}
            </select>
            <input class="input" data-list="services" data-index="${i}" data-key="title" value="${esc(s.title)}" placeholder="${esc(d.org ? `${s.name} | ${d.org}` : 'Título de la transmisión')}" />
            <button type="button" class="icon-btn" data-remove="services" data-index="${i}" title="Quitar">${icon('trash')}</button>
          </div>`)
        .join('');
      const t = d.transmission;
      const scan = state.obsScan;
      return (
        field('Servicios', `<div class="list-editor">${rows}</div><div class="btn-row" style="margin-top:10px"><button type="button" class="btn sm" data-add-service>${icon('plus', 'sm')} Agregar servicio</button></div>`) +
        (t.software === 'obs'
          ? field('Escena de transmisión en OBS', `<div class="input-row">${input('transmission.obs.scene', t.obs.scene, 'Opcional (ej. Transmisión)', 'list="dl-scenes"')}<button type="button" class="btn sm" data-scan-obs>${icon('refresh', 'sm')} Leer de OBS</button></div>${datalist('dl-scenes', scan?.scenes || [])}`,
            scan ? (scan.connected ? `OBS conectado: ${scan.scenes.length} escenas, ${scan.textSources.length} fuentes de texto.` : `No se pudo leer OBS${scan.error ? `: ${esc(scan.error)}` : ''}.`) : 'Si la eliges, la app la pone al aire al preparar.') +
            field('Fuente de texto para el título', `${input('transmission.obs.titleSource', t.obs.titleSource, 'Opcional (ej. Título)', 'list="dl-text"')}${datalist('dl-text', scan?.textSources || [])}`, 'Si tienes un texto en OBS con el título (cintillo), la app lo cambia según el servicio.')
          : '')
      );
    },
  },
  presenter: {
    title: 'Programa de presentación',
    lead: 'El que proyecta letras y versículos en esta computadora.',
    render: (d) =>
      field('Programa', chips('screen.software', 'presenter', d.screen.software)) +
      (d.screen.software === 'propresenter'
        ? field('Puerto de la API de red (opcional)', input('screen.apiPort', d.screen.apiPort || '', '50001', 'data-num inputmode="numeric"'), 'En ProPresenter: Ajustes → Red → Habilitar red. Con el puerto, la app confirma que responde.')
        : ''),
  },
  outputs: {
    title: 'Pantallas de salida',
    lead: 'Cuántas pantallas salen de esta computadora, además de la tuya. La app revisa que estén conectadas, en escritorio extendido, y muestra un patrón en cada una.',
    render: (d) => {
      const rows = d.screen.outputs
        .map((o, i) => `<div class="list-row" style="grid-template-columns: 40px 1fr 1.4fr 34px">
            <span class="tile" style="width:34px;height:34px">${i + 2}</span>
            ${select(`data-list="screen.outputs" data-index="${i}" data-key="role"`, 'outputRole', o.role)}
            <input class="input" data-list="screen.outputs" data-index="${i}" data-key="name" value="${esc(o.name)}" placeholder="Nombre (ej. Proyector principal)" />
            <button type="button" class="icon-btn" data-remove="screen.outputs" data-index="${i}" title="Quitar">${icon('trash')}</button>
          </div>`)
        .join('');
      return (
        field('Pantallas', `<div class="list-editor">${rows || '<p class="note">Sin pantallas de salida.</p>'}</div>
          <div class="btn-row" style="margin-top:10px">${d.screen.outputs.length < 4 ? `<button type="button" class="btn sm" data-add-output>${icon('plus', 'sm')} Agregar pantalla</button>` : ''}</div>`,
          'La pantalla 1 es la tuya (operador). <b>Receptor inalámbrico</b>: un transmisor HDMI que manda la imagen a una TV. <b>Retorno</b>: la que ve quien predica o canta.') +
        `<div class="field">${toggle('screen.ndiOut', d.screen.ndiOut, 'Envía letras por NDI', 'Para que la computadora de transmisión las reciba en OBS.')}</div>`
      );
    },
  },
  general: {
    title: 'General',
    lead: '',
    render: (d) => field('Tema', chips('theme', 'theme', d.theme)),
  },
};

const STEPS = {
  transmission: ['team', 'software', 'destination', 'browser', 'audio', 'cameras', 'services'],
  screen: ['team', 'presenter', 'outputs'],
};

/* ------------------------------------------------------------------ */
/* Vistas                                                               */
/* ------------------------------------------------------------------ */
function render() {
  applyTheme();
  const s = state.settings;
  const content = $('#content');
  const sidebar = $('#sidebar');
  const service = serviceById(state.service);
  $('#brand-mode').textContent = !s.mode || state.view === 'home' || state.view === 'wizard'
    ? ''
    : s.mode === 'transmission' ? `Transmisión${service ? ` · ${service.name}` : ''}` : `Pantalla${s.computerName ? ` · ${s.computerName}` : ''}`;

  const full = state.view === 'home' || state.view === 'wizard';
  sidebar.classList.toggle('hidden', full);
  content.classList.toggle('center', full);
  if (!full) sidebar.innerHTML = renderSidebar();

  if (state.view === 'home') content.innerHTML = renderHome();
  else if (state.view === 'wizard') content.innerHTML = renderWizard();
  else if (state.view === 'settings') content.innerHTML = renderSettings();
  else if (state.view === 'detail') content.innerHTML = renderDetail(state.detail);
  else content.innerHTML = renderChecklist();
}

function renderHome() {
  const card = (mode, ic, title, tags, text) => `
    <button type="button" class="mode-card" data-mode="${mode}">
      <span class="mode-icon">${icon(ic, 'xl')}</span>
      <h3>${title}</h3>
      <span class="mode-tags">${tags}</span>
      <p>${text}</p>
      <span class="btn primary">Comenzar ${icon('arrow', 'sm')}</span>
    </button>`;
  const org = state.settings.org;
  return `<div class="home">
    <svg class="home-logo" viewBox="0 0 32 32"><use href="#home-logo-src"/></svg>
    <h1>Kerygma Live</h1>
    <p class="sub">${org ? `${esc(org)} · ` : ''}Centro de preparación del servicio</p>
    <h2>¿Qué va a preparar esta computadora?</h2>
    <div class="modes">
      ${card('transmission', 'tower', 'Transmisión', 'OBS · Facebook / YouTube · Audio · Cámaras', 'Valida la transmisión en vivo: internet, OBS, la página y la clave, el audio, las cámaras y el título del servicio.')}
      ${card('screen', 'monitor', 'Pantalla', 'Holyrics / ProPresenter · Proyector · NDI', 'Valida la proyección: el programa de letras, las pantallas conectadas, el escritorio extendido y la salida.')}
    </div>
    <p class="home-foot">Una misma app en cada computadora · cada una revisa lo suyo</p>
  </div>`;
}

function renderWizard() {
  const steps = STEPS[state.draft.mode];
  const id = steps[state.step];
  const sec = SECTIONS[id];
  const last = state.step === steps.length - 1;
  return `<div class="wizard">
    <div class="steps">${steps.map((_, i) => `<i class="${i <= state.step ? 'done' : ''}"></i>`).join('')}</div>
    <div class="wizard-card">
      <div class="eyebrow">${state.draft.mode === 'transmission' ? 'Transmisión' : 'Pantalla'} · Paso ${state.step + 1} de ${steps.length}</div>
      <h1>${esc(sec.title)}</h1>
      <p class="lead">${esc(sec.lead)}</p>
      ${sec.render(state.draft)}
      <div class="wizard-nav">
        <button type="button" class="btn ghost" data-wizard="back">${icon('back', 'sm')} ${state.step === 0 ? 'Cambiar modo' : 'Atrás'}</button>
        <button type="button" class="btn primary" data-wizard="next">${last ? 'Terminar y revisar' : 'Siguiente'} ${icon('arrow', 'sm')}</button>
      </div>
    </div>
  </div>`;
}

function statusOf(id) {
  return state.results[id]?.status || 'pending';
}

function renderSidebar() {
  const nav = (view, ic, label, extra = '', active = false) =>
    `<button type="button" class="nav-item ${active ? 'active' : ''}" data-nav="${view}">${icon(ic)}<span>${esc(label)}</span>${extra}</button>`;
  return [
    nav('checklist', 'checklist', 'Checklist', '', state.view === 'checklist'),
    '<div class="nav-label">Revisiones</div>',
    ...state.items.map((it) => nav(`detail:${it.id}`, it.icon, it.title, `<i class="dot ${statusOf(it.id)}"></i>`, state.view === 'detail' && state.detail === it.id)),
    '<div class="nav-spacer"></div>',
    nav('settings', 'settings', 'Configuración', '', state.view === 'settings'),
    nav('home', 'swap', 'Cambiar modo'),
  ].join('');
}

function pill(status) {
  const st = status || 'pending';
  return `<span class="pill ${st}">${st === 'running' ? '<span class="spinner"></span>' : `<i class="dot ${st}"></i>`}${STATUS_TEXT[st]}</span>`;
}

function summary() {
  let done = 0;
  let blocking = 0;
  for (const it of state.items) {
    const st = statusOf(it.id);
    if (st === 'ok' || st === 'warn' || st === 'skipped') done++;
    else if (it.required) blocking++;
  }
  return { done, total: state.items.length, ready: state.items.length > 0 && blocking === 0 };
}

function serviceSwitch() {
  const s = state.settings;
  if (s.mode !== 'transmission' || s.services.length < 2) return '';
  return `<div class="segmented">${s.services.map((x) => `<button type="button" class="${x.id === state.service ? 'on' : ''}" data-service="${x.id}">${esc(x.name)}</button>`).join('')}</div>`;
}

function renderChecklist() {
  const s = state.settings;
  const sum = summary();
  const isTx = s.mode === 'transmission';
  const canStart = isTx && s.transmission.software === 'obs';
  const pct = sum.total ? Math.round((sum.done / sum.total) * 100) : 0;
  const rows = state.items
    .map((it) => {
      const r = state.results[it.id];
      const sub = r?.message || it.subtitle;
      return `<button type="button" class="check-row" data-nav="detail:${it.id}">
        <span class="tile">${icon(it.icon)}</span>
        <span><b>${esc(it.title)}${it.required ? '' : ' <span class="muted" style="font-weight:500">· opcional</span>'}</b><small>${esc(sub)}</small></span>
        ${pill(r?.status)}
        ${icon('chevron')}
      </button>`;
    })
    .join('');

  const ready = sum.ready
    ? `<div class="ready-card">
        <span class="ready-badge">${icon('check')}</span>
        <h2>${isTx ? '¡Todo listo para transmitir!' : '¡Pantallas listas!'}</h2>
        <p>${isTx ? 'Los elementos obligatorios están configurados. Encender, iniciar y terminar sigue siendo cosa de personas.' : 'Todo lo obligatorio está revisado. Ya puedes proyectar.'}</p>
        <div class="tiles">${state.items.map((it) => {
          const st = statusOf(it.id);
          return `<div class="mini">${icon(it.icon)}<span><b>${esc(it.title)}</b><small class="${st}">${STATUS_TEXT[st]}</small></span></div>`;
        }).join('')}</div>
        ${canStart ? `<button type="button" class="btn primary big" data-start-stream>${icon('broadcast')} Iniciar transmisión</button>` : ''}
      </div>`
    : '';

  return `<div class="page-head">
      <div>
        <h1>Checklist de ${isTx ? 'transmisión' : 'pantalla'}</h1>
        <p>${sum.done} de ${sum.total} completados${s.computerName ? ` · ${esc(s.computerName)}` : ''}</p>
      </div>
      <div class="btn-row">
        ${serviceSwitch()}
        <button type="button" class="btn primary" data-prepare ${state.preparing ? 'disabled' : ''}>
          ${state.preparing ? '<span class="spinner"></span> Preparando…' : `${icon('sparkle', 'sm')} Preparar todo`}
        </button>
      </div>
    </div>
    <div class="progress ${sum.ready ? 'ok' : ''}"><i style="width:${pct}%"></i></div>
    ${ready}
    <div class="check-list">${rows}</div>`;
}

function meter(db) {
  // 24 segmentos de -60 a 0 dB.
  const on = Math.max(0, Math.min(24, Math.round(((db + 60) / 60) * 24)));
  return `<span class="meter">${Array.from({ length: 24 }, (_, i) => `<i class="${i < on ? 'on' : ''} ${i >= 20 ? 'hot' : ''} ${i >= 23 ? 'clip' : ''}"></i>`).join('')}</span>`;
}

function renderDetail(id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return renderChecklist();
  const r = state.results[id] || { status: 'pending', message: 'Todavía no se revisa.', details: [], actions: [{ id: 'retry', label: 'Revisar ahora', primary: true }] };
  const st = r.status;
  const facts = (r.details || [])
    .map((d) => `<div class="fact"><span>${esc(d.label)}</span><span class="val">${d.status ? `<i class="dot ${d.status}"></i>` : ''}${d.meter !== undefined ? meter(d.meter) : ''}${esc(d.value)}</span></div>`)
    .join('');
  const previews = [...(r.previews || []), ...(r.preview ? [{ label: it.title, src: r.preview }] : [])]
    .filter((p) => /^data:image\//.test(p.src))
    .map((p) => `<figure><img src="${p.src}" alt="" /><figcaption>${esc(p.label)}</figcaption></figure>`)
    .join('');
  const actions = (r.actions || [])
    .map((a) => `<button type="button" class="btn ${a.primary ? 'primary' : ''}" data-action="${esc(a.id)}" data-check="${id}" ${st === 'running' ? 'disabled' : ''}>${esc(a.label)}</button>`)
    .join('');

  let extra = '';
  if (id === 'title' && state.settings.services.length) {
    const s = serviceById(state.service) || state.settings.services[0];
    extra = `<div class="panel"><div class="field-label">Servicio</div>${serviceSwitch() || `<b>${esc(s.name)}</b>`}
      <div class="field"><span class="field-label">Título</span><div class="input-row"><input class="input" value="${esc(serviceTitle(s))}" readonly /></div>
      <p class="note">Se cambia en Configuración → Servicios y títulos.</p></div></div>`;
  }

  return `<div class="detail">
    <div class="detail-head">
      <span class="tile big">${icon(it.icon, 'lg')}</span>
      <div><h1>${esc(it.title)}</h1><p>${esc(it.subtitle)}</p></div>
      ${pill(st)}
    </div>
    ${r.message ? `<div class="message ${st}">${st === 'running' ? '<span class="spinner"></span>' : icon(STATUS_ICON[st])}<span>${esc(r.message)}</span></div>` : ''}
    ${r.help ? `<div class="help">${icon('info')}<span>${esc(r.help)}</span></div>` : ''}
    ${extra}
    ${facts ? `<div class="facts">${facts}</div>` : ''}
    ${previews ? `<div class="previews">${previews}</div>` : ''}
    ${actions ? `<div class="btn-row">${actions}</div>` : ''}
  </div>`;
}

function renderSettings() {
  const d = state.draft;
  const ids = ['general', 'team', ...STEPS[d.mode].filter((x) => x !== 'team')];
  return `<div class="settings-page">
    <div class="page-head"><div><h1>Configuración</h1><p>Modo ${d.mode === 'transmission' ? 'Transmisión' : 'Pantalla'} · ${esc(d.computerName || state.info.hostname)} · Kerygma Live ${esc(state.info.version)}</p></div></div>
    ${ids.map((id) => `<section class="panel"><h2>${esc(SECTIONS[id].title)}</h2>${SECTIONS[id].lead ? `<p>${esc(SECTIONS[id].lead)}</p>` : ''}${SECTIONS[id].render(d)}</section>`).join('')}
    ${d.mode === 'transmission' && d.transmission.software === 'obs' ? `<section class="panel"><h2>OBS en otra computadora</h2><p>Solo si OBS no está en esta computadora. En la misma, la app lee la conexión del propio OBS.</p>
      ${field('Dirección', `<div class="input-row">${input('transmission.obs.host', d.transmission.obs.host, '127.0.0.1')}${input('transmission.obs.port', d.transmission.obs.port, '4455', 'data-num style="max-width:110px"')}</div>`)}
      ${secretField('obsPassword', 'Contraseña del WebSocket', 'Contraseña de OBS', 'OBS → Herramientas → Ajustes del servidor WebSocket → Mostrar información de conexión.')}</section>` : ''}
    <div class="save-bar"><button type="button" class="btn" data-nav="checklist">Cancelar</button><button type="button" class="btn primary" data-save-settings>${icon('check', 'sm')} Guardar</button></div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Acciones                                                             */
/* ------------------------------------------------------------------ */
async function reload(info) {
  state.info = info || (await api.init());
  state.settings = state.info.settings;
  state.items = state.info.items;
  if (!state.service || !serviceById(state.service)) state.service = state.info.service;
}

async function saveSecrets() {
  for (const [name, value] of Object.entries(state.secretDraft)) {
    if (value && value.trim()) state.info.secrets = await api.setSecret(name, value);
  }
  state.secretDraft = {};
}

/** Revisa todo una vez sin abrir ni cambiar nada (al entrar al checklist). */
async function quickCheck() {
  for (const it of state.items) {
    if (state.preparing) return;
    if (['identify', 'output', 'ndiout'].includes(it.id) && !state.results[it.id]) {
      await api.runCheck(it.id, { devices: state.devices });
      continue;
    }
    await api.runCheck(it.id, { devices: state.devices, light: true });
  }
}

/** Revisa solas, cada pocos segundos, las que están pendientes o con error (cámaras que se conectan después, etc.). */
let watching = false;
setInterval(async () => {
  if (watching || state.preparing || !['checklist', 'detail'].includes(state.view)) return;
  watching = true;
  try {
    for (const it of state.items) {
      const st = statusOf(it.id);
      if (!['error', 'pending'].includes(st) || ['identify', 'output', 'ndiout', 'title'].includes(it.id) || !state.results[it.id]) continue;
      if (state.preparing) break;
      await api.runCheck(it.id, { devices: state.devices, light: true });
    }
  } finally {
    watching = false;
  }
}, 8000);

async function prepare() {
  state.preparing = true;
  render();
  await refreshDevices();
  try {
    const sum = await api.prepare(state.devices);
    if (sum) toast(sum.ready ? 'Listo: todo lo obligatorio está revisado.' : `${sum.done} de ${sum.total} listos. Revisa lo que falta.`, sum.ready ? 'ok' : 'error');
  } finally {
    state.preparing = false;
    render();
  }
}

async function runAction(checkId, actionId) {
  if (actionId === 'open-settings') {
    openSettings();
    return;
  }
  const res = await api.action(checkId, actionId, state.devices);
  if (res?.error) toast(res.error, 'error');
  else if (actionId === 'copy-key') toast('Clave copiada. Se borra del portapapeles en 1 minuto.');
  else if (actionId === 'copy-title') toast('Título copiado.');
  else if (actionId === 'show-pattern') toast('Patrón en cada pantalla (se cierra en 15 s).');
}

function openSettings() {
  scanObsQuietly();
  state.draft = clone(state.settings);
  state.secretDraft = {};
  state.view = 'settings';
  render();
}

function confirmModal({ icon: ic, title, text, ok, cancel = 'Cancelar' }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    modal.innerHTML = `<div class="modal-card"><span class="tile big" style="margin:0 auto">${icon(ic, 'lg')}</span><h2>${esc(title)}</h2><p>${esc(text)}</p>
      <div class="btn-row"><button type="button" class="btn" data-m="0">${esc(cancel)}</button><button type="button" class="btn primary" data-m="1">${esc(ok)}</button></div></div>`;
    modal.classList.remove('hidden');
    modal.onclick = (e) => {
      const b = e.target.closest('[data-m]');
      if (!b && e.target !== modal) return;
      modal.classList.add('hidden');
      resolve(b?.dataset.m === '1');
    };
  });
}

/** Lee de OBS (si está abierto) escenas, fuentes de texto y fuentes NDI para sugerir nombres. */
function scanObsQuietly() {
  if (!state.info.obsWebsocket.enabled) return;
  api.scanObs().then((scan) => {
    if (!scan.connected) return;
    state.obsScan = scan;
    // Sin interrumpir a quien está escribiendo.
    if (['wizard', 'settings'].includes(state.view) && !document.activeElement?.matches('input, select')) render();
  });
}

function startWizard(mode) {
  scanObsQuietly();
  state.draft = clone(state.settings);
  state.draft.mode = mode;
  if (!state.draft.computerName) state.draft.computerName = state.info.hostname;
  state.secretDraft = {};
  state.step = 0;
  state.view = 'wizard';
  render();
}

async function finishSetup() {
  await saveSecrets();
  await reload(await api.saveSettings({ ...state.draft, setupDone: true }));
  state.results = {};
  state.view = 'checklist';
  render();
  quickCheck();
}

/* ------------------------------------------------------------------ */
/* Eventos                                                              */
/* ------------------------------------------------------------------ */
const content = $('#content');

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-nav]');
  if (!t) return;
  const ds = t.dataset;

  if (ds.nav) {
    const [view, id] = ds.nav.split(':');
    if (view === 'home') {
      state.view = 'home';
    } else if (view === 'settings') {
      openSettings();
      return;
    } else {
      state.view = view;
      state.detail = id || null;
      if (view === 'detail' && !state.results[id]) api.runCheck(id, { devices: state.devices, light: true });
    }
    render();
    content.scrollTop = 0;
    return;
  }
  if (ds.mode) {
    if (state.settings.setupDone && state.settings.mode === ds.mode) {
      state.view = 'checklist';
      render();
      quickCheck();
    } else startWizard(ds.mode);
    return;
  }
  if (ds.wizard) {
    const steps = STEPS[state.draft.mode];
    if (ds.wizard === 'back') {
      if (state.step === 0) state.view = 'home';
      else state.step--;
    } else if (state.step < steps.length - 1) state.step++;
    else return finishSetup();
    render();
    return;
  }
  if (ds.chip) {
    setPath(state.draft, ds.chip, ds.value);
    if (ds.chip === 'theme') {
      state.settings.theme = ds.value;
      applyTheme();
    }
    render();
    return;
  }
  if (ds.toggle) {
    setPath(state.draft, ds.toggle, !getPath(state.draft, ds.toggle));
    render();
    return;
  }
  if (ds.addCamera) {
    const cams = state.draft.transmission.cameras;
    const n = cams.length + 1;
    const name = { ndi: `Celular ${cams.filter((c) => c.type === 'ndi').length + 1}`, capture: 'Capturadora HDMI', webcam: 'Cámara USB', switcher: 'Switcher', ip: 'Cámara PTZ' }[ds.addCamera];
    if (cams.length < 8) cams.push({ id: `c${Date.now().toString(36)}${n}`, name, type: ds.addCamera, source: '' });
    render();
    return;
  }
  if (ds.addService !== undefined) {
    state.draft.services.push({ id: `s${Date.now().toString(36)}`, name: 'Servicio', weekday: null, title: '' });
    render();
    return;
  }
  if (ds.addOutput !== undefined) {
    state.draft.screen.outputs.push({ id: `o${Date.now().toString(36)}`, role: state.draft.screen.outputs.length ? 'stage' : 'projector', name: '' });
    render();
    return;
  }
  if (ds.remove) {
    getPath(state.draft, ds.remove).splice(Number(ds.index), 1);
    render();
    return;
  }
  if (ds.clearSecret) {
    state.info.secrets = await api.setSecret(ds.clearSecret, '');
    toast('Clave borrada.');
    render();
    return;
  }
  if (ds.scanObs !== undefined) {
    t.disabled = true;
    state.obsScan = await api.scanObs();
    render();
    return;
  }
  if (ds.saveSettings !== undefined) {
    await saveSecrets();
    await reload(await api.saveSettings(state.draft));
    state.view = 'checklist';
    render();
    toast('Configuración guardada.');
    quickCheck();
    return;
  }
  if (ds.prepare !== undefined) return prepare();
  if (ds.service) {
    state.service = ds.service;
    render();
    api.setService(ds.service);
    return;
  }
  if (ds.action) return runAction(ds.check, ds.action);
  if (ds.startStream !== undefined) {
    const s = state.settings;
    const dest = { facebook: 'Facebook Live', youtube: 'YouTube Live', custom: 'el servidor RTMP' }[s.transmission.destination];
    const ok = await confirmModal({
      icon: 'broadcast', title: 'Iniciar transmisión',
      text: `OBS empezará a transmitir a ${dest}${s.transmission.pageName ? ` (${s.transmission.pageName})` : ''}. En Facebook, la publicación sale al aire cuando la publiques desde el Productor en vivo.`,
      ok: 'Sí, iniciar',
    });
    if (!ok) return;
    const res = await api.startStream();
    if (res.error) toast(res.error, 'error');
    else {
      toast('OBS está transmitiendo.');
      api.runCheck('scenes', { devices: state.devices });
    }
  }
});

// Campos de texto: se guardan en el borrador sin volver a dibujar (para no perder el foco).
content.addEventListener('input', (e) => {
  const el = e.target;
  const num = el.hasAttribute('data-num');
  const value = num ? (el.value === '' ? null : Number(el.value)) : el.value;
  if (el.dataset.input) setPath(state.draft, el.dataset.input, value);
  else if (el.dataset.secret) state.secretDraft[el.dataset.secret] = el.value;
  else if (el.dataset.list) getPath(state.draft, el.dataset.list)[Number(el.dataset.index)][el.dataset.key] = value;
});
content.addEventListener('change', (e) => {
  // Cambiar el tipo de cámara cambia la sugerencia del campo de al lado.
  if (e.target.matches('select[data-list]')) render();
});

api.onCheckUpdate(({ id, result }) => {
  state.results[id] = result;
  if (['checklist', 'detail'].includes(state.view)) render();
});

/* ------------------------------------------------------------------ */
/* Arranque                                                             */
/* ------------------------------------------------------------------ */
(async () => {
  // El logo grande de la pantalla inicial reutiliza el de la barra superior.
  const logo = $('.topbar .logo').cloneNode(true);
  logo.querySelector('linearGradient').id = 'lg2';
  logo.querySelector('rect').setAttribute('fill', 'url(#lg2)');
  const sym = document.createElementNS('http://www.w3.org/2000/svg', 'symbol');
  sym.id = 'home-logo-src';
  sym.setAttribute('viewBox', '0 0 32 32');
  sym.innerHTML = logo.innerHTML;
  $('.sprite defs').append(sym);

  await reload();
  document.body.classList.add(`platform-${state.info.platform}`);
  tickClock();
  setInterval(tickClock, 15000);
  state.view = state.settings.setupDone && state.settings.mode ? 'checklist' : 'home';
  render();
  // Listar micrófonos y cámaras puede tardar en macOS: primero se dibuja la app.
  await refreshDevices();
  if (state.view === 'checklist') quickCheck();
})();
