/**
 * Qué se revisa en cada modo, según la configuración de la computadora.
 * Sin dependencias de Electron: la misma lista la usan el proceso principal, la interfaz
 * (vía IPC) y las pruebas.
 *
 * Estados de cada revisión:
 *   pending  todavía no se revisa        running  revisando ahora
 *   ok       pasó                        warn     funciona, pero algo conviene mirar
 *   error    falló y necesita atención   confirm  hace falta que una persona lo confirme
 *   skipped  se omitió (no cuenta como aprobada, pero no bloquea)
 */

const STATUSES = ['pending', 'running', 'ok', 'warn', 'error', 'confirm', 'skipped'];

const SOFTWARE = {
  obs: 'OBS Studio', streamlabs: 'Streamlabs Desktop', vmix: 'vMix', ecamm: 'Ecamm Live', other: 'Programa de transmisión',
};
const PRESENTER = {
  holyrics: 'Holyrics', propresenter: 'ProPresenter', easyworship: 'EasyWorship', openlp: 'OpenLP', other: 'Programa de presentación',
};
const DESTINATION = { facebook: 'Facebook Live', youtube: 'YouTube Live', custom: 'Servidor RTMP' };
const BROWSER = { default: 'Navegador predeterminado', safari: 'Safari', chrome: 'Google Chrome', edge: 'Microsoft Edge', firefox: 'Firefox', none: '' };
const AUDIO_SOURCE = { external: 'Audio externo', computer: 'Micrófono de la computadora' };
const CAMERA_TYPE = {
  ndi: 'Celular o cámara por NDI', capture: 'Capturadora HDMI', webcam: 'Cámara USB',
  switcher: 'Switcher o módulo de cámaras', ip: 'Cámara IP / PTZ por NDI',
};
const OUTPUT_ROLE = {
  projector: 'Proyector', tv: 'Pantalla o TV', receiver: 'Receptor inalámbrico', stage: 'Pantalla de retorno',
};

/** Cámaras que llegan a OBS como fuente NDI (las demás son dispositivos de video de la computadora). */
const isNdiCamera = (c) => c.type === 'ndi' || c.type === 'ip';

function transmissionChecks(s) {
  const t = s.transmission;
  const usesObs = t.software === 'obs';
  const list = [
    { id: 'internet', icon: 'wifi', title: 'Conexión a internet', subtitle: 'Conexión, latencia y velocidad de subida', required: true },
    {
      id: 'software', icon: 'broadcast', title: SOFTWARE[t.software],
      subtitle: usesObs ? 'Abierto y conectado por WebSocket' : 'Abierto y listo', required: true,
    },
  ];
  const dest = DESTINATION[t.destination] || 'Destino';
  if (t.browser && t.browser !== 'none') {
    list.push({
      id: 'page', icon: 'globe', title: `${BROWSER[t.browser]} · ${dest}`,
      subtitle: t.pageName ? `Página de ${t.pageName}` : 'Página de la transmisión', required: true,
    });
  }
  if (usesObs) {
    list.push({ id: 'streamkey', icon: 'key', title: 'Clave de transmisión', subtitle: `Configurada en OBS para ${dest}`, required: true });
  }
  const external = t.audio.source !== 'computer';
  list.push({
    id: 'audio', icon: 'mic', title: external ? (t.audio.device ? `Audio · ${t.audio.device}` : 'Audio externo') : 'Audio de la computadora',
    subtitle: external ? `Que ${usesObs ? 'OBS' : 'la transmisión'} no use el micrófono de la computadora, y la señal` : 'Elegido a propósito: se revisa la señal',
    required: t.audio.required,
  });
  if (t.lyrics.enabled) {
    list.push({ id: 'lyrics', icon: 'text', title: 'Letras y versículos (NDI)', subtitle: `Fuente ${t.lyrics.source || 'NDI'} en ${usesObs ? 'OBS' : 'la transmisión'}`, required: true });
  }
  if (t.cameras.length) {
    const ndi = t.cameras.filter(isNdiCamera).length;
    const local = t.cameras.length - ndi;
    const parts = [ndi && `${ndi} por NDI`, local && `${local} por cable`].filter(Boolean).join(' · ');
    list.push({ id: 'cameras', icon: 'camera', title: 'Cámaras', subtitle: parts, required: false });
  }
  if (usesObs) {
    list.push({ id: 'scenes', icon: 'layers', title: 'Escenas y salida', subtitle: 'Escena de transmisión, fuentes y video de salida', required: true });
  }
  list.push({ id: 'title', icon: 'calendar', title: 'Título del servicio', subtitle: 'Según el día de la reunión', required: false });
  return list;
}

function screenChecks(s) {
  const sc = s.screen;
  const list = [
    { id: 'presenter', icon: 'presentation', title: PRESENTER[sc.software], subtitle: 'Instalado y abierto', required: true },
    {
      id: 'displays', icon: 'monitor', title: 'Pantallas conectadas',
      subtitle: `${sc.outputs.length} de salida esperada${sc.outputs.length === 1 ? '' : 's'} · escritorio extendido`, required: true,
    },
    { id: 'identify', icon: 'grid', title: 'Prueba de imagen', subtitle: 'Patrón en cada pantalla para ubicarla', required: true },
    { id: 'output', icon: 'cast', title: `Salida de ${PRESENTER[sc.software]}`, subtitle: 'Presentación en la pantalla correcta', required: true },
  ];
  if (sc.ndiOut) list.push({ id: 'ndiout', icon: 'share', title: 'Salida NDI', subtitle: 'Letras y versículos para la transmisión', required: true });
  list.push({ id: 'network', icon: 'wifi', title: 'Red', subtitle: 'Red local e internet', required: false });
  return list;
}

/** Resumen de la configuración en una línea (para el encabezado del checklist). */
function setupSummary(settings) {
  if (settings.mode === 'transmission') {
    const t = settings.transmission;
    const cams = t.cameras.length;
    return [
      SOFTWARE[t.software],
      DESTINATION[t.destination] || 'Sin destino',
      t.browser === 'none' ? 'Sin navegador' : BROWSER[t.browser] || 'Sin navegador',
      AUDIO_SOURCE[t.audio.source] || AUDIO_SOURCE.external,
      cams ? `${cams} cámara${cams === 1 ? '' : 's'}` : null,
      t.lyrics.enabled ? 'Letras por NDI' : null,
    ].filter(Boolean).join(' · ');
  }
  if (settings.mode === 'screen') {
    const n = settings.screen.outputs.length;
    return [PRESENTER[settings.screen.software], `${n} pantalla${n === 1 ? '' : 's'} de salida`, settings.screen.ndiOut ? 'Salida NDI' : null].filter(Boolean).join(' · ');
  }
  return '';
}

/** Lista de revisiones del modo elegido. */
function checklist(settings) {
  if (settings.mode === 'transmission') return transmissionChecks(settings);
  if (settings.mode === 'screen') return screenChecks(settings);
  return [];
}

/** Resumen del avance: cuántas pasaron y si ya se puede empezar. */
function summarize(items, results) {
  let done = 0;
  let blocking = 0;
  for (const item of items) {
    const st = results[item.id]?.status || 'pending';
    if (st === 'ok' || st === 'warn' || st === 'skipped') done++;
    else if (item.required) blocking++;
  }
  return { done, total: items.length, ready: items.length > 0 && blocking === 0 };
}

/** Servicio que corresponde a una fecha (por día de la semana); si ninguno coincide, el primero. */
function serviceFor(services, date = new Date()) {
  if (!services.length) return null;
  return services.find((s) => s.weekday === date.getDay()) || services[0];
}

/** Título efectivo de un servicio: el escrito, o "Nombre | Organización". */
function serviceTitle(service, org) {
  if (!service) return '';
  if (service.title) return service.title;
  return org ? `${service.name} | ${org}` : service.name;
}

module.exports = {
  STATUSES, SOFTWARE, PRESENTER, DESTINATION, BROWSER, AUDIO_SOURCE, CAMERA_TYPE, OUTPUT_ROLE,
  isNdiCamera, checklist, setupSummary, summarize, serviceFor, serviceTitle,
};
