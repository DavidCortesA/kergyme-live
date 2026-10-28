/**
 * Cada revisión del checklist: qué mira, qué arregla sola y qué acciones ofrece.
 *
 * run(id, ctx) devuelve { status, message, details: [{ label, value, status? }], actions: [{ id, label, primary? }], preview? }
 * act(id, action, ctx) ejecuta una acción y vuelve a revisar.
 *
 * ctx = { settings, auto, devices, secrets, electron, state }
 *   auto     true durante "Preparar todo": abre programas y aplica la configuración sola
 *   devices  dispositivos de audio y video que ve la interfaz ({ audioinput: [], videoinput: [] })
 *   state    memoria de la sesión (confirmaciones, omitidas, último nivel de audio, etc.)
 */
const apps = require('../core/apps');
const obsApi = require('../core/obs');
const obsConfig = require('../core/obs-config');
const browser = require('../core/browser');
const network = require('../core/network');
const displaysCore = require('../core/displays');
const { DESTINATION, BROWSER, PRESENTER, OUTPUT_ROLE, CAMERA_TYPE, isNdiCamera, serviceFor, serviceTitle } = require('../core/checklist');

const IS_MAC = process.platform === 'darwin';
// Por encima de esto hay sonido; un micrófono abierto en silencio ronda los -48 dB.
const SIGNAL_DB = -45;
const obs = new obsApi.ObsClient();
const { matches } = obsApi;

const result = (status, message, extra = {}) => ({ status, message, details: [], actions: [], ...extra });
const action = (id, label, primary = false) => ({ id, label, primary });
const maskKey = (key) => (key ? `••••••••${key.slice(-4)}` : '—');
const isLocalHost = (h) => ['127.0.0.1', 'localhost', '::1', ''].includes(String(h || '').trim());

/* ------------------------------------------------------------------ */
/* OBS                                                                  */
/* ------------------------------------------------------------------ */

/** Datos de conexión: los del archivo de OBS si es esta misma computadora; si no, los de Configuración. */
function obsConnection(ctx) {
  const cfg = ctx.settings.transmission.obs;
  if (isLocalHost(cfg.host)) {
    const ws = obsConfig.readWebsocket();
    return { host: '127.0.0.1', port: ws.exists ? ws.port : cfg.port, password: ws.authRequired ? ws.password : '', file: ws };
  }
  return { host: cfg.host, port: cfg.port, password: ctx.secrets.get('obsPassword'), file: null };
}

/** Tras abrir OBS, su servidor WebSocket tarda unos segundos más que la ventana en aceptar conexiones. */
async function waitForObs(ctx, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await ensureObs(ctx);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

async function ensureObs(ctx) {
  if (obs.connected) return obs;
  const c = obsConnection(ctx);
  await obs.connect({ host: c.host, port: c.port, password: c.password });
  return obs;
}

/** Sin OBS abierto, lo que depende de él queda pendiente (no es un error de esa revisión). */
const obsDown = (err) =>
  ['UNREACHABLE', 'CLOSED', 'TIMEOUT', 'NOT_CONNECTED'].includes(err.code)
    ? result('pending', 'Esperando a OBS: ábrelo o usa “Preparar todo”.', { actions: [action('retry', 'Reintentar')] })
    : result('error', err.message || 'No hay conexión con OBS.', { actions: [action('retry', 'Reintentar', true)] });

/** ¿Llega imagen? Toma una captura chica de la fuente y mira si es negra. */
async function sourceSignal(ctx, sourceName) {
  try {
    const { imageData } = await obs.request('GetSourceScreenshot', { sourceName, imageFormat: 'png', imageWidth: 160, imageHeight: 90 });
    const img = ctx.electron.nativeImage.createFromDataURL(imageData);
    const px = img.toBitmap();
    let sum = 0;
    let sumSq = 0;
    const n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) {
      const y = 0.299 * px[i + 2] + 0.587 * px[i + 1] + 0.114 * px[i]; // BGRA
      sum += y;
      sumSq += y * y;
    }
    const avg = sum / n;
    const sd = Math.sqrt(Math.max(0, sumSq / n - avg * avg));
    return { preview: imageData, black: avg < 8 && sd < 4 };
  } catch {
    return { preview: null, black: null };
  }
}

/* ------------------------------------------------------------------ */
/* Revisiones de Transmisión                                           */
/* ------------------------------------------------------------------ */

async function internet(ctx, { light = false } = {}) {
  const lan = network.localAddress();
  const reach = await network.reachable();
  const details = [
    { label: 'Red local', value: lan ? `${lan.address} (${lan.name})` : 'Sin red', status: lan ? 'ok' : 'error' },
    ...reach.sites.map((s) => ({ label: s.host, value: s.ok ? 'Responde' : 'Sin respuesta', status: s.ok ? 'ok' : 'error' })),
  ];
  if (!reach.ok) return result('error', 'No hay conexión a internet. Revisa el cable de red o el Wi-Fi.', { details, actions: [action('retry', 'Reintentar', true)] });

  const prev = ctx.state.speed;
  if (light && prev) return { ...prev, details: [...details, ...prev.speedDetails] };

  const [ms, up, down] = [await network.latency(), await network.upload().catch(() => null), await network.download().catch(() => null)];
  const isTransmission = ctx.settings.mode === 'transmission';
  const bitrate = ctx.settings.transmission.bitrateKbps;
  const need = network.recommendedUpload(bitrate);
  const speedDetails = [
    { label: 'Latencia', value: ms === null ? '—' : `${ms} ms`, status: ms === null || ms > 150 ? 'warn' : 'ok' },
    { label: 'Subida', value: up === null ? 'No se pudo medir' : `${up} Mbps`, status: up === null ? 'warn' : isTransmission && up < need ? (up * 1000 < bitrate ? 'error' : 'warn') : 'ok' },
    { label: 'Bajada', value: down === null ? '—' : `${down} Mbps` },
  ];
  if (isTransmission) speedDetails.push({ label: 'Recomendado', value: `${need} Mbps de subida para ${bitrate} kbps` });

  let status = 'ok';
  let message = isTransmission ? `Conexión estable: ${up} Mbps de subida.` : 'Conexión a internet correcta.';
  if (up !== null && isTransmission && up * 1000 < bitrate) {
    status = 'error';
    message = `La subida (${up} Mbps) no alcanza para ${bitrate} kbps. Baja el bitrate de OBS o usa cable de red.`;
  } else if (speedDetails.some((d) => d.status === 'warn')) {
    status = 'warn';
    message = up !== null && isTransmission && up < need ? `La subida (${up} Mbps) es justa para ${bitrate} kbps; conviene cable de red o bajar el bitrate.` : 'Conexión con latencia alta o sin medición de velocidad.';
  }
  const res = result(status, message, { details: [...details, ...speedDetails], actions: [action('retry', 'Medir de nuevo')] });
  ctx.state.speed = { ...res, speedDetails };
  return res;
}

async function software(ctx, opts = {}) {
  const id = ctx.settings.transmission.software;
  return presenterOrSoftware(ctx, id, opts);
}

/** Programa de transmisión o de presentación: instalado, abierto y (para OBS) conectado. */
async function presenterOrSoftware(ctx, id, { light = false } = {}) {
  let st = await apps.status(id);
  if (!st.installed) {
    return result('error', `${st.name} no está instalado en esta computadora.`, {
      actions: st.url ? [action('install', `Descargar ${st.name}`, true), action('retry', 'Reintentar')] : [action('retry', 'Reintentar')],
    });
  }
  if (!st.running && ctx.auto) {
    // Para OBS: si el WebSocket está apagado, se activa antes de abrirlo.
    if (id === 'obs' && isLocalHost(ctx.settings.transmission.obs.host) && !obsConfig.readWebsocket().enabled) obsConfig.enableWebsocket();
    await apps.open(st.path);
    await apps.waitRunning(id, st.path);
    if (id === 'obs') await waitForObs(ctx);
    st = await apps.status(id);
  }
  const details = [{ label: 'Ubicación', value: st.path }];
  if (!st.running) {
    return result('error', `${st.name} está cerrado.`, { details, actions: [action('open-app', `Abrir ${st.name}`, true)] });
  }
  if (id !== 'obs') {
    if (id === 'propresenter' && ctx.settings.screen.apiPort) {
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.settings.screen.apiPort}/version`, { signal: AbortSignal.timeout(3000) });
        const v = await res.json();
        details.push({ label: 'API de red', value: `ProPresenter ${v.host_description || v.api_version || ''}`.trim(), status: 'ok' });
      } catch {
        details.push({ label: 'API de red', value: `No responde en el puerto ${ctx.settings.screen.apiPort}`, status: 'warn' });
      }
    }
    return result('ok', `${st.name} está abierto.`, { details, actions: [action('open-app', 'Traer al frente')] });
  }

  // OBS: conexión por WebSocket
  const conn = obsConnection(ctx);
  if (conn.file && !conn.file.enabled) {
    return result('error', 'El servidor WebSocket de OBS está apagado, así que la app no puede revisar ni configurar OBS.', {
      details: [...details, { label: 'WebSocket', value: 'Apagado', status: 'error' }],
      help: 'Ciérralo y usa “Activar WebSocket”, o en OBS ve a Herramientas → Ajustes del servidor WebSocket y marca “Activar servidor WebSocket”.',
      actions: [action('enable-websocket', 'Activar WebSocket', true), action('retry', 'Reintentar')],
    });
  }
  try {
    await ensureObs(ctx);
  } catch (err) {
    return result('error', err.message, { details, actions: [action('retry', 'Reintentar', true)] });
  }
  if (light && ctx.state.obsInfo) return ctx.state.obsInfo;
  try {
    const v = await obs.request('GetVersion');
    const { currentSceneCollectionName } = await obs.request('GetSceneCollectionList');
    const { currentProfileName } = await obs.request('GetProfileList');
    const stream = await obs.request('GetStreamStatus');
    const res = result(stream.outputActive ? 'warn' : 'ok', stream.outputActive ? 'OBS ya está transmitiendo.' : 'OBS está abierto y conectado.', {
      details: [
        ...details,
        { label: 'Versión', value: `OBS ${v.obsVersion} · WebSocket ${v.obsWebSocketVersion}` },
        { label: 'Perfil', value: currentProfileName },
        { label: 'Colección de escenas', value: currentSceneCollectionName },
        { label: 'Salida', value: stream.outputActive ? 'Transmitiendo' : 'Lista (sin transmitir)', status: stream.outputActive ? 'warn' : 'ok' },
      ],
      actions: [action('open-app', 'Ver en OBS')],
    });
    ctx.state.obsInfo = res;
    return res;
  } catch (err) {
    return obsDown(err);
  }
}

async function page(ctx) {
  const t = ctx.settings.transmission;
  const b = t.browser;
  const live = browser.livePageFor(t.destination, t.pageUrl);
  const st = await apps.status(b);
  if (!st.installed) return result('error', `${BROWSER[b]} no está instalado.`, { actions: [action('retry', 'Reintentar')] });

  const who = t.pageName || 'la página de la iglesia';
  const confirmed = ctx.state.confirmed.has('page');
  const actions = [action('open-page', `Abrir ${DESTINATION[t.destination]}`)];
  if (t.pageUrl) actions.push(action('open-profile', 'Abrir la página'));

  if (!browser.canRead(b)) {
    if (ctx.auto && !confirmed) await apps.open(st.path, live);
    return confirmed
      ? result('ok', `Confirmado: transmitiendo como ${who}.`, { actions })
      : result('confirm', `Revisa en ${BROWSER[b]} que estés en ${DESTINATION[t.destination]} como ${who}.`, { actions: [action('confirm', 'Sí, estoy en la página correcta', true), ...actions] });
  }

  if (!st.running) {
    if (!ctx.auto) return result('error', `${BROWSER[b]} está cerrado.`, { actions: [action('open-page', `Abrir ${DESTINATION[t.destination]}`, true)] });
    await apps.open(st.path, live);
    await apps.waitRunning(b, st.path, 10000);
    await new Promise((r) => setTimeout(r, 1500));
  }

  let url;
  try {
    url = await browser.currentUrl(b);
  } catch (err) {
    if (err.code === 'NOT_AUTHORIZED') {
      return result(confirmed ? 'ok' : 'confirm', `Para revisar la página, permite que Kerygma Live controle ${BROWSER[b]} en Privacidad y seguridad → Automatización. Mientras tanto, confírmalo a mano.`, {
        actions: [action('confirm', 'Estoy en la página correcta', !confirmed), action('open-automation', 'Abrir Automatización'), ...actions],
      });
    }
    url = '';
  }
  let m = browser.pageMatches(url, t.pageUrl, t.destination);
  if (!m.ok && ctx.auto) {
    await browser.goTo(b, live).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    url = await browser.currentUrl(b).catch(() => '');
    m = browser.pageMatches(url, t.pageUrl, t.destination);
  }
  const details = [{ label: 'Pestaña al frente', value: url || 'Sin ventanas abiertas', status: m.ok ? 'ok' : 'error' }];
  if (!m.ok) {
    return result('error', `${m.reason}. Abre ${DESTINATION[t.destination]} para transmitir como ${who}.`, { details, actions: [action('go-page', `Ir a ${DESTINATION[t.destination]}`, true), ...actions.slice(1)] });
  }
  if (t.destination === 'facebook' && !confirmed) {
    return result('confirm', `Estás en Facebook. Confirma que la publicación sale como ${who} (no como tu perfil personal).`, {
      details,
      help: `Si no, toca tu foto de perfil arriba a la derecha → “Ver todos los perfiles” → ${who}.`,
      actions: [action('confirm', `Sí, como ${who}`, true), ...actions],
    });
  }
  return result('ok', `Estás en la página correcta${t.destination === 'facebook' ? ` como ${who}` : ''}.`, { details, actions });
}

async function streamkey(ctx) {
  const t = ctx.settings.transmission;
  const key = ctx.secrets.get('streamKey');
  const server = t.destination === 'custom' ? t.server : obsApi.STREAM_SERVERS[t.destination];
  if (!key) {
    return result('error', 'Todavía no hay clave de transmisión guardada.', {
      help: t.destination === 'facebook' ? 'En Facebook: Productor en vivo → “Clave de transmisión persistente” → Copiar, y pégala en Configuración.' : 'Cópiala del panel de transmisión y pégala en Configuración.',
      actions: [action('open-settings', 'Guardar clave', true), action('open-page', `Abrir ${DESTINATION[t.destination]}`)],
    });
  }
  if (!server) return result('error', 'Falta la dirección del servidor RTMP.', { actions: [action('open-settings', 'Configurar', true)] });
  try {
    await ensureObs(ctx);
    let target = await obsApi.streamTarget(obs);
    const same = () => target.key === key && (target.server === server || target.server.replace(/\/+$/, '') === server.replace(/\/+$/, ''));
    const { outputActive } = await obs.request('GetStreamStatus');
    if (!same() && ctx.auto && !outputActive) {
      await obsApi.setStreamTarget(obs, server, key);
      target = await obsApi.streamTarget(obs);
    }
    const details = [
      { label: 'Destino', value: DESTINATION[t.destination] },
      { label: 'Servidor en OBS', value: target.server || target.service || '—', status: target.server === server ? 'ok' : 'error' },
      { label: 'Clave en OBS', value: maskKey(target.key), status: target.key === key ? 'ok' : 'error' },
    ];
    const actions = [action('copy-key', 'Copiar clave')];
    if (same()) return result('ok', 'OBS tiene la clave y el servidor correctos.', { details, actions });
    if (outputActive) return result('warn', 'OBS está transmitiendo con otra configuración; no se cambia en vivo.', { details, actions });
    return result('error', 'OBS tiene otra clave o servidor.', { details, actions: [action('apply-key', 'Poner la clave en OBS', true), ...actions] });
  } catch (err) {
    return obsDown(err);
  }
}

/** Busca el dispositivo de audio en la computadora (lo que ve la interfaz, o system_profiler en Mac). */
async function systemHas(ctx, kind, hint) {
  const list = (ctx.devices?.[kind] || []).filter(Boolean);
  if (list.some((d) => matches(d, hint))) return true;
  if (IS_MAC && kind === 'audioinput') {
    const { out } = await apps.run('system_profiler', ['SPAudioDataType']);
    return matches(out, hint);
  }
  if (IS_MAC && kind === 'videoinput') {
    const { out } = await apps.run('system_profiler', ['SPCameraDataType', 'SPUSBDataType']);
    return matches(out, hint);
  }
  return false;
}

async function audio(ctx, { light = false } = {}) {
  const t = ctx.settings.transmission;
  const hint = t.audio.device;
  const label = hint || 'la entrada de audio';
  // Pendiente (no omitido) para que se siga revisando solo; si no es obligatorio, no bloquea.
  const missingStatus = 'pending';
  const inSystem = hint ? await systemHas(ctx, 'audioinput', hint) : true;

  if (t.software !== 'obs') {
    if (!inSystem) return result(missingStatus, `No se detecta ${label}. Conéctalo; se revisará solo.`, { actions: [action('retry', 'Reintentar', true)] });
    return result('ok', `${label} está conectado a la computadora.`, { actions: [action('retry', 'Reintentar')] });
  }

  try {
    await ensureObs(ctx);
    const inputs = await obsApi.audioInputs(obs);
    const using = hint ? inputs.find((i) => matches(i.deviceName, hint)) : inputs.find((i) => !i.isDefault) || inputs[0];
    const defaults = inputs.filter((i) => i.isDefault && !i.muted && i !== using);
    const details = [
      { label: 'Dispositivo', value: hint ? (inSystem ? `${hint} conectado` : `${hint} no detectado`) : 'Sin nombre configurado', status: inSystem ? 'ok' : 'error' },
      { label: 'Fuente en OBS', value: using ? `${using.inputName} (${using.deviceName || 'por defecto'})` : 'Ninguna lo usa', status: using ? (using.muted ? 'error' : 'ok') : 'error' },
    ];
    if (defaults.length) details.push({ label: 'También entra', value: defaults.map((d) => `${d.inputName} (micrófono por defecto)`).join(', '), status: 'warn' });

    if (!inSystem && !using) {
      return result(missingStatus, `No se detecta ${label}. Si aún no está conectado, se revisará solo cuando lo conectes.`, {
        details, actions: [action('retry', 'Reintentar', true), action('skip', 'Omitir por ahora')],
      });
    }
    if (!using) {
      return result('error', `OBS no está tomando el audio de ${label}.`, { details, actions: [action('use-device', `Usar ${hint} en OBS`, true), action('retry', 'Reintentar')] });
    }
    if (using.muted) return result('error', `La fuente “${using.inputName}” está silenciada en OBS.`, { details, actions: [action('unmute', 'Quitar silencio', true)] });

    if (ctx.auto && !light) ctx.state.audioLevel = { input: using.inputName, db: (await obsApi.measureLevels(obs, 3000))[using.inputName] };
    const level = ctx.state.audioLevel?.input === using.inputName ? ctx.state.audioLevel.db : null;
    if (level !== null && level !== undefined) {
      details.push({ label: 'Nivel de audio', value: Number.isFinite(level) ? `${level} dB` : 'Sin señal', status: level > SIGNAL_DB ? 'ok' : 'warn', meter: Number.isFinite(level) ? level : -100 });
    }
    const actions = [action('test-signal', 'Probar señal (5 s)', level === null), action('retry', 'Reintentar')];
    if (defaults.length) actions.unshift(action('mute-default', 'Silenciar el micrófono por defecto', true));
    if (defaults.length) return result('warn', `OBS toma ${label}, pero también el micrófono por defecto de la computadora.`, { details, actions });
    if (level === null) return result('confirm', `OBS toma ${label}. Habla o toca algo y prueba la señal.`, { details, actions });
    if (level <= SIGNAL_DB) return result('warn', `No llega sonido de ${label}. Revisa que la consola esté encendida y con volumen, y prueba otra vez.`, { details, actions });
    return result('ok', `OBS recibe audio de ${label}.`, { details, actions });
  } catch (err) {
    return obsDown(err);
  }
}

/** Revisa una fuente NDI esperada en OBS: existe, su emisor está en la red y llega imagen. */
async function ndiSource(ctx, hint, inputs, onNetwork) {
  const input = inputs.find((i) => matches(i.ndiName, hint) || matches(i.inputName, hint));
  if (!input) {
    const onNet = onNetwork.find((n) => matches(n, hint));
    return { status: 'error', value: onNet ? `En la red como “${onNet}”, pero OBS no tiene una fuente NDI para él` : 'No hay fuente NDI en OBS', canCreate: !!onNet, ndiName: onNet };
  }
  if (!onNetwork.some((n) => n === input.ndiName)) return { status: 'pending', value: `“${input.inputName}”: el emisor no está en la red`, input };
  const sig = await sourceSignal(ctx, input.inputName);
  if (sig.black) return { status: 'warn', value: `“${input.inputName}”: llega en negro`, input, preview: sig.preview };
  return { status: 'ok', value: `“${input.inputName}” recibe imagen`, input, preview: sig.preview };
}

const ndiList = (inputs) => inputs.map((i) => `${i.inputName} (${i.ndiName || 'sin emisor'})`).join(', ') || 'Ninguna';

async function ndiContext() {
  const inputs = await obsApi.ndiInputs(obs);
  const onNetwork = inputs.length ? await obsApi.ndiNetworkSources(obs, inputs[0].inputName) : [];
  const { inputKinds } = await obs.request('GetInputKindList', { unversioned: true });
  return { inputs, onNetwork, hasNdi: inputKinds.some(obsApi.isNdiKind), ndiKind: inputKinds.find(obsApi.isNdiKind) };
}

async function lyrics(ctx) {
  const hint = ctx.settings.transmission.lyrics.source || 'Holyrics';
  try {
    await ensureObs(ctx);
    const n = await ndiContext();
    if (!n.hasNdi) return result('error', 'OBS no tiene NDI. Instala el plugin DistroAV y el NDI Runtime.', { actions: [action('install-ndi', 'Descargar DistroAV', true)] });
    const r = await ndiSource(ctx, hint, n.inputs, n.onNetwork);
    const details = [
      { label: 'Fuente', value: r.value, status: r.status },
      { label: 'Fuentes NDI en OBS', value: ndiList(n.inputs) },
      { label: 'Emisores NDI en la red', value: n.onNetwork.join(', ') || 'Ninguno' },
    ];
    const actions = [action('retry', 'Reintentar', r.status !== 'ok')];
    if (r.canCreate) actions.unshift(action('create-ndi:lyrics', 'Crear la fuente en OBS', true));
    else if (r.status === 'error') actions.push(action('open-settings', 'Cambiar el nombre'));
    const msg = {
      ok: `Llegan las letras y versículos (“${r.input?.inputName}”).`,
      warn: 'La fuente de letras llega en negro: revisa que haya algo proyectado o activa el fondo en el programa de letras.',
      pending: `La computadora de las letras no está enviando NDI (“${r.input?.ndiName}”). ¿Está encendida, en la misma red y con la salida NDI activada?`,
      error: r.canCreate
        ? 'El emisor de letras está en la red, pero OBS no tiene su fuente.'
        : `Ninguna fuente NDI de OBS se llama “${hint}”.${n.inputs.length ? ' Pon en Configuración el nombre de la fuente de letras (está en la lista de abajo).' : ''}`,
    }[r.status];
    return result(r.status === 'pending' ? 'error' : r.status, msg, { details, actions, preview: r.preview });
  } catch (err) {
    return obsDown(err);
  }
}

async function cameras(ctx) {
  const cams = ctx.settings.transmission.cameras;
  const usesObs = ctx.settings.transmission.software === 'obs';
  try {
    const details = [];
    const previews = [];
    let n = null;
    let local = null;
    if (usesObs) await ensureObs(ctx);
    for (const cam of cams) {
      const hint = cam.source || cam.name;
      if (isNdiCamera(cam)) {
        if (!usesObs) {
          details.push({ label: cam.name, value: 'Revisa la fuente NDI en tu programa', status: 'confirm' });
          continue;
        }
        n = n || (await ndiContext());
        const r = await ndiSource(ctx, hint, n.inputs, n.onNetwork);
        details.push({ label: cam.name, value: r.status === 'pending' ? 'No detectado: conecta el celular y abre la app NDI' : r.value, status: r.status === 'pending' ? 'pending' : r.status, camId: cam.id, canCreate: r.canCreate });
        if (r.preview) previews.push({ label: cam.name, src: r.preview });
      } else {
        const inSystem = await systemHas(ctx, 'videoinput', hint);
        let status = inSystem ? 'ok' : 'pending';
        let value = inSystem ? `${CAMERA_TYPE[cam.type]} conectada` : 'No detectada: revisa el cable USB';
        if (usesObs && inSystem) {
          local = local || (await obsApi.videoDeviceInputs(obs));
          const input = local.find((i) => matches(i.device, hint) || matches(i.inputName, hint));
          if (!input) {
            status = 'error';
            value = 'Conectada, pero ninguna fuente de OBS la usa';
          } else {
            const sig = await sourceSignal(ctx, input.inputName);
            if (sig.preview) previews.push({ label: cam.name, src: sig.preview });
            if (sig.black) {
              status = 'warn';
              value = `“${input.inputName}”: llega en negro (¿cámara apagada o sin HDMI?)`;
            } else value = `“${input.inputName}” recibe imagen`;
          }
        }
        details.push({ label: cam.name, value, status });
      }
    }
    if (n && details.some((d) => d.status === 'error' && !d.canCreate)) details.push({ label: 'Fuentes NDI en OBS', value: ndiList(n.inputs) });
    const missing = details.filter((d) => d.status === 'pending' || d.status === 'error').length;
    const actions = [action('retry', 'Revisar de nuevo', missing > 0)];
    for (const d of details.filter((x) => x.canCreate)) actions.unshift(action(`create-ndi:${d.camId}`, `Crear fuente de ${d.label}`));
    if (missing) actions.push(action('skip', 'Omitir por ahora'));
    if (!missing) return result(details.some((d) => d.status === 'warn') ? 'warn' : 'ok', 'Todas las cámaras están conectadas.', { details, actions, previews });
    return result('pending', `${missing} de ${cams.length} cámara${cams.length === 1 ? '' : 's'} sin conectar. Se revisan solas cada pocos segundos.`, { details, actions, previews });
  } catch (err) {
    return obsDown(err);
  }
}

async function scenes(ctx) {
  const want = ctx.settings.transmission.obs.scene;
  try {
    await ensureObs(ctx);
    const list = await obs.request('GetSceneList');
    const names = list.scenes.map((s) => s.sceneName);
    let current = list.currentProgramSceneName;
    if (want && !names.includes(want)) {
      return result('error', `No existe la escena “${want}” en OBS.`, { details: [{ label: 'Escenas', value: names.join(', ') }], actions: [action('open-settings', 'Elegir escena', true)] });
    }
    if (want && current !== want && ctx.auto) {
      await obs.request('SetCurrentProgramScene', { sceneName: want });
      current = want;
    }
    const items = await obsApi.sceneItems(obs, current);
    const visible = items.filter((i) => i.enabled && !i.group);
    const hidden = items.filter((i) => !i.enabled && !i.group);
    const video = await obs.request('GetVideoSettings');
    const fps = Math.round((video.fpsNumerator / video.fpsDenominator) * 100) / 100;
    const stream = await obs.request('GetStreamStatus');
    const details = [
      { label: 'Escena actual', value: current, status: !want || current === want ? 'ok' : 'error' },
      { label: 'Fuentes visibles', value: visible.map((i) => i.name).join(', ') || 'Ninguna', status: visible.length ? 'ok' : 'error' },
      { label: 'Resolución de salida', value: `${video.outputWidth} × ${video.outputHeight} (${fps} fps)`, status: video.outputHeight >= 720 ? 'ok' : 'warn' },
      { label: 'Estado de salida', value: stream.outputActive ? 'Transmitiendo' : 'Listo (sin transmitir)', status: stream.outputActive ? 'warn' : 'ok' },
    ];
    if (hidden.length) details.splice(2, 0, { label: 'Ocultas', value: hidden.map((i) => i.name).join(', '), status: 'warn' });
    const actions = [action('open-app', 'Ver en OBS')];
    if (want && current !== want) {
      actions.unshift(action('set-scene', `Cambiar a “${want}”`, true));
      return result('error', `La escena al aire es “${current}”, no “${want}”.`, { details, actions });
    }
    if (!visible.length) return result('error', `La escena “${current}” no tiene fuentes visibles.`, { details, actions });
    return result('ok', `Escena “${current}” lista para transmitir.`, { details, actions });
  } catch (err) {
    return obsDown(err);
  }
}

async function title(ctx) {
  const s = ctx.settings;
  const service = s.services.find((x) => x.id === ctx.state.serviceId) || serviceFor(s.services);
  if (!service) return result('skipped', 'No hay servicios configurados.', { actions: [action('open-settings', 'Configurar', true)] });
  const text = serviceTitle(service, s.org);
  const source = s.transmission.obs.titleSource;
  const details = [{ label: 'Servicio', value: service.name }, { label: 'Título', value: text }];
  const actions = [action('copy-title', 'Copiar título')];

  if (s.transmission.software === 'obs' && source) {
    try {
      await ensureObs(ctx);
      const { inputSettings } = await obs.request('GetInputSettings', { inputName: source });
      if (inputSettings.text !== text && ctx.auto) await obsApi.setText(obs, source, text);
      const current = ctx.auto ? text : inputSettings.text;
      details.push({ label: `Texto “${source}” en OBS`, value: current || '(vacío)', status: current === text ? 'ok' : 'error' });
      if (current !== text) return result('error', 'El título en OBS es de otro servicio.', { details, actions: [action('apply-title', 'Aplicar en OBS', true), ...actions] });
    } catch (err) {
      if (err.code === 'REQUEST_600') return result('error', `No existe la fuente de texto “${source}” en OBS.`, { details, actions: [action('open-settings', 'Elegir fuente', true)] });
      return obsDown(err);
    }
  }
  if (ctx.auto) ctx.electron.clipboard.writeText(text);
  return result('ok', ctx.auto ? `Título listo y copiado para pegarlo en ${DESTINATION[s.transmission.destination]}.` : `Título de ${service.name} listo.`, { details, actions, service: service.id });
}

/* ------------------------------------------------------------------ */
/* Revisiones de Pantalla                                              */
/* ------------------------------------------------------------------ */

function presenter(ctx, opts) {
  return presenterOrSoftware(ctx, ctx.settings.screen.software, opts);
}

function currentDisplays(ctx) {
  const { screen } = ctx.electron;
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Pantalla ${i + 1}`,
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    primary: d.id === primary,
    internal: !!d.internal,
    bounds: d.bounds,
  }));
}

async function displays(ctx) {
  const list = currentDisplays(ctx);
  const mirrored = IS_MAC ? displaysCore.macMirrored((await apps.run('system_profiler', ['SPDisplaysDataType'])).out) : false;
  const a = displaysCore.assess(list, ctx.settings.screen.outputs, mirrored);
  const outputs = ctx.settings.screen.outputs;
  const details = list.map((d) => {
    const idx = list.filter((x) => !x.primary).indexOf(d);
    const role = d.primary ? 'Operador (principal)' : outputs[idx] ? outputs[idx].name || OUTPUT_ROLE[outputs[idx].role] : 'Extra';
    return { label: d.label, value: `${d.width} × ${d.height} · ${role}`, status: d.primary ? undefined : 'ok' };
  });
  for (const n of a.notes) details.push({ label: 'Nota', value: n, status: 'warn' });
  return result(a.status, a.message, { details, actions: [action('show-pattern', 'Identificar pantallas', a.status !== 'error'), action('open-display-settings', 'Ajustes de pantalla'), action('retry', 'Reintentar')] });
}

function identify(ctx) {
  if (ctx.state.confirmed.has('identify')) return result('ok', 'Confirmaste que cada pantalla muestra su imagen.', { actions: [action('show-pattern', 'Mostrar de nuevo')] });
  if (ctx.auto) ctx.showPatterns();
  return result('confirm', 'Muestra el patrón en cada pantalla y confirma que se ve en el proyector o TV correcto.', {
    actions: [action('show-pattern', 'Mostrar patrón', !ctx.auto), action('confirm', 'Se ve en todas', ctx.auto)],
  });
}

const OUTPUT_GUIDE = {
  holyrics: 'En Holyrics abre la configuración de pantallas (proyección) y elige la pantalla de salida que viste en el patrón. Si usas pantalla de retorno, asígnala como pantalla de retorno o escenario.',
  propresenter: 'En ProPresenter ve a Pantallas → Configurar pantallas: asigna el Proyector a la pantalla de audiencia y, si la usas, la de retorno a Escenario.',
  easyworship: 'En EasyWorship ve a Opciones → Salida y elige el monitor de salida que viste en el patrón.',
  openlp: 'En OpenLP ve a Configuración → General → Pantallas y elige la pantalla de salida.',
  other: 'En tu programa de presentación elige la pantalla de salida que viste en el patrón.',
};

function output(ctx) {
  const sw = ctx.settings.screen.software;
  if (ctx.state.confirmed.has('output')) return result('ok', `La presentación de ${PRESENTER[sw]} sale en la pantalla correcta.`, { actions: [action('open-app', `Abrir ${PRESENTER[sw]}`)] });
  return result('confirm', 'Proyecta algo (una letra o un versículo) y confirma que se ve en la pantalla de salida y no en la tuya.', {
    help: OUTPUT_GUIDE[sw],
    actions: [action('confirm', 'Sale en la pantalla correcta', true), action('open-app', `Abrir ${PRESENTER[sw]}`)],
  });
}

function ndiout(ctx) {
  const sw = PRESENTER[ctx.settings.screen.software];
  if (ctx.state.confirmed.has('ndiout')) return result('ok', 'Confirmaste que la salida NDI está activa.');
  const lan = network.localAddress();
  return result('confirm', `Activa la salida NDI en ${sw} y confirma con la computadora de transmisión que llegan las letras.`, {
    details: [{ label: 'Red local', value: lan ? `${lan.address} (${lan.name})` : 'Sin red: NDI no funcionará', status: lan ? 'ok' : 'error' }],
    help: 'Ambas computadoras deben estar en la misma red. En la de transmisión, Kerygma Live revisa que llegue la fuente en el paso “Letras y versículos”.',
    actions: [action('confirm', 'La salida NDI está activa', true)],
  });
}

async function networkCheck(ctx) {
  const lan = network.localAddress();
  const reach = await network.reachable();
  const details = [
    { label: 'Red local', value: lan ? `${lan.address} (${lan.name})` : 'Sin red', status: lan ? 'ok' : 'error' },
    { label: 'Internet', value: reach.ok ? 'Conectado' : 'Sin conexión', status: reach.ok ? 'ok' : 'warn' },
  ];
  if (!lan) return result('error', 'No hay red local: la salida NDI no llegará a la computadora de transmisión.', { details, actions: [action('retry', 'Reintentar', true)] });
  return result(reach.ok ? 'ok' : 'warn', reach.ok ? 'Red local e internet funcionando.' : 'Hay red local pero no internet (NDI funciona igual).', { details, actions: [action('retry', 'Reintentar')] });
}

/* ------------------------------------------------------------------ */
/* Registro                                                            */
/* ------------------------------------------------------------------ */

const RUNNERS = { internet, software, page, streamkey, audio, lyrics, cameras, scenes, title, presenter, displays, identify, output, ndiout, network: networkCheck };

/** Revisiones que se pueden repetir sin molestar (no abren programas ni miden velocidad). */
const LIGHT = new Set(['software', 'presenter', 'page', 'streamkey', 'audio', 'lyrics', 'cameras', 'scenes', 'displays', 'network', 'internet']);

async function run(id, ctx, opts = {}) {
  if (ctx.state.skipped.has(id)) return result('skipped', 'Omitido por ahora.', { actions: [action('unskip', 'Volver a revisar', true)] });
  const fn = RUNNERS[id];
  if (!fn) return result('error', `Revisión desconocida: ${id}`);
  try {
    return await fn(ctx, opts);
  } catch (err) {
    return result('error', err.message || String(err), { actions: [action('retry', 'Reintentar', true)] });
  }
}

/** Acciones de los botones. Devuelve true si después hay que volver a revisar. */
async function act(id, actionId, ctx) {
  const t = ctx.settings.transmission;
  const [name, arg] = actionId.split(':');
  switch (name) {
    case 'retry':
    case 'test-signal':
      if (name === 'test-signal') {
        await ensureObs(ctx);
        const inputs = await obsApi.audioInputs(obs);
        const using = t.audio.device ? inputs.find((i) => matches(i.deviceName, t.audio.device)) : inputs.find((i) => !i.isDefault) || inputs[0];
        if (using) ctx.state.audioLevel = { input: using.inputName, db: (await obsApi.measureLevels(obs, 5000))[using.inputName] };
      }
      if (id === 'internet') ctx.state.speed = null;
      if (id === 'software' || id === 'presenter') ctx.state.obsInfo = null;
      return true;
    case 'skip':
      ctx.state.skipped.add(id);
      return true;
    case 'unskip':
      ctx.state.skipped.delete(id);
      return true;
    case 'confirm':
      ctx.state.confirmed.add(id);
      return true;
    case 'install': {
      const sw = id === 'presenter' ? ctx.settings.screen.software : t.software;
      if (apps.CATALOG[sw]?.url) await ctx.electron.shell.openExternal(apps.CATALOG[sw].url);
      return false;
    }
    case 'install-ndi':
      await ctx.electron.shell.openExternal('https://github.com/DistroAV/DistroAV/releases/latest');
      return false;
    case 'open-app': {
      const sw = id === 'presenter' || id === 'output' ? ctx.settings.screen.software : t.software;
      const st = await apps.status(sw);
      if (st.path) {
        await apps.open(st.path);
        await apps.waitRunning(sw, st.path, 15000);
        if (sw === 'obs') await waitForObs(ctx);
      }
      ctx.state.obsInfo = null;
      return true;
    }
    case 'enable-websocket': {
      const st = await apps.status('obs');
      if (st.running) throw new Error('Cierra OBS para activar el WebSocket (OBS reescribe su configuración al salir), o actívalo en Herramientas → Ajustes del servidor WebSocket.');
      obsConfig.enableWebsocket();
      return true;
    }
    case 'open-page':
    case 'go-page':
    case 'open-profile': {
      const url = name === 'open-profile' ? t.pageUrl : browser.livePageFor(t.destination, t.pageUrl);
      if (name === 'go-page' && browser.canRead(t.browser)) await browser.goTo(t.browser, url);
      else {
        const st = await apps.status(t.browser === 'none' ? 'safari' : t.browser);
        if (st.path) await apps.open(st.path, url);
        else await ctx.electron.shell.openExternal(url);
      }
      await new Promise((r) => setTimeout(r, 1500));
      return true;
    }
    case 'open-automation':
      await ctx.electron.shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
      return false;
    case 'open-display-settings':
      await ctx.electron.shell.openExternal(IS_MAC ? 'x-apple.systempreferences:com.apple.Displays-Settings.extension' : 'ms-settings:display');
      return false;
    case 'apply-key': {
      await ensureObs(ctx);
      const server = t.destination === 'custom' ? t.server : obsApi.STREAM_SERVERS[t.destination];
      const { outputActive } = await obs.request('GetStreamStatus');
      if (outputActive) throw new Error('OBS está transmitiendo; detén la transmisión antes de cambiar la clave.');
      await obsApi.setStreamTarget(obs, server, ctx.secrets.get('streamKey'));
      return true;
    }
    case 'copy-key':
      ctx.electron.clipboard.writeText(ctx.secrets.get('streamKey') || '');
      setTimeout(() => {
        // La clave no se queda en el portapapeles más de un minuto.
        if (ctx.electron.clipboard.readText() === ctx.secrets.get('streamKey')) ctx.electron.clipboard.clear();
      }, 60000);
      return false;
    case 'use-device':
      await useAudioDevice(ctx);
      return true;
    case 'mute-default': {
      await ensureObs(ctx);
      const inputs = await obsApi.audioInputs(obs);
      for (const i of inputs.filter((x) => x.isDefault && !x.muted && !matches(x.deviceName, t.audio.device))) {
        await obs.request('SetInputMute', { inputName: i.inputName, inputMuted: true });
      }
      return true;
    }
    case 'unmute': {
      await ensureObs(ctx);
      const inputs = await obsApi.audioInputs(obs);
      const using = inputs.find((i) => matches(i.deviceName, t.audio.device));
      if (using) await obs.request('SetInputMute', { inputName: using.inputName, inputMuted: false });
      return true;
    }
    case 'create-ndi':
      await createNdiInput(ctx, arg);
      return true;
    case 'set-scene':
      await ensureObs(ctx);
      await obs.request('SetCurrentProgramScene', { sceneName: t.obs.scene });
      return true;
    case 'apply-title':
    case 'copy-title': {
      const service = ctx.settings.services.find((x) => x.id === (arg || ctx.state.serviceId)) || serviceFor(ctx.settings.services);
      const text = serviceTitle(service, ctx.settings.org);
      if (name === 'apply-title' && t.obs.titleSource) {
        await ensureObs(ctx);
        await obsApi.setText(obs, t.obs.titleSource, text);
      }
      ctx.electron.clipboard.writeText(text);
      return name === 'apply-title';
    }
    case 'show-pattern':
      ctx.showPatterns();
      return false;
    case 'open-settings':
      return false; // lo resuelve la interfaz
    default:
      throw new Error(`Acción desconocida: ${actionId}`);
  }
}

/** Pone el dispositivo de audio configurado en una fuente de OBS (la de Mic/Aux o una nueva). */
async function useAudioDevice(ctx) {
  const hint = ctx.settings.transmission.audio.device;
  await ensureObs(ctx);
  const inputs = await obsApi.audioInputs(obs);
  const kind = IS_MAC ? 'coreaudio_input_capture' : 'wasapi_input_capture';
  const probe = inputs[0];
  if (probe) {
    const devices = await obsApi.audioDevices(obs, probe.inputName);
    const dev = devices.find((d) => matches(d.name, hint));
    if (!dev) throw new Error(`OBS no ve ningún dispositivo llamado “${hint}”. ¿Está conectado?`);
    // Se reutiliza la fuente que usa el micrófono por defecto (normalmente "Mic/Aux").
    const target = inputs.find((i) => i.isDefault) || probe;
    await obs.request('SetInputSettings', { inputName: target.inputName, inputSettings: { device_id: dev.id }, overlay: true });
    await obs.request('SetInputMute', { inputName: target.inputName, inputMuted: false });
    return;
  }
  // No hay ninguna fuente de audio: se crea en la escena actual y se le asigna el dispositivo.
  const { currentProgramSceneName } = await obs.request('GetSceneList');
  const inputName = `Audio ${hint}`;
  await obs.request('CreateInput', { sceneName: currentProgramSceneName, inputName, inputKind: kind, inputSettings: {} });
  const devices = await obsApi.audioDevices(obs, inputName);
  const dev = devices.find((d) => matches(d.name, hint));
  if (dev) await obs.request('SetInputSettings', { inputName, inputSettings: { device_id: dev.id }, overlay: true });
}

/** Crea en la escena actual una fuente NDI apuntando al emisor que coincide (letras o una cámara). */
async function createNdiInput(ctx, which) {
  await ensureObs(ctx);
  const t = ctx.settings.transmission;
  const cam = t.cameras.find((c) => c.id === which);
  const hint = which === 'lyrics' ? t.lyrics.source || 'Holyrics' : cam.source || cam.name;
  const inputName = which === 'lyrics' ? 'Letras (NDI)' : cam.name;
  const n = await ndiContext();
  const ndiName = n.onNetwork.find((x) => matches(x, hint));
  if (!ndiName) throw new Error(`No hay ningún emisor NDI llamado “${hint}” en la red.`);
  const { currentProgramSceneName } = await obs.request('GetSceneList');
  await obs.request('CreateInput', { sceneName: currentProgramSceneName, inputName, inputKind: n.ndiKind, inputSettings: { ndi_source_name: ndiName } });
}

/** Inicia la transmisión en OBS (la interfaz pide confirmación antes). */
async function startStream(ctx) {
  await ensureObs(ctx);
  await obs.request('StartStream');
}

module.exports = { run, act, LIGHT, startStream, currentDisplays, obs };
