/**
 * Cliente mínimo de OBS WebSocket 5 (incluido en OBS 28 o posterior), sin dependencias:
 * usa el WebSocket global de Node 22+ / Electron.
 *
 * Protocolo: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
 *   0 Hello → 1 Identify → 2 Identified · 3 Reidentify · 5 Event · 6 Request → 7 RequestResponse
 */
const crypto = require('crypto');

const OP = { HELLO: 0, IDENTIFY: 1, IDENTIFIED: 2, REIDENTIFY: 3, EVENT: 5, REQUEST: 6, RESPONSE: 7 };
// Todas las suscripciones normales; los medidores de volumen van aparte porque llegan 20 veces por segundo.
const EVENTS_ALL = 0x7ff;
const EVENTS_METERS = 1 << 16;

/** Servidores de ingesta de cada destino (con "Personalizado" en OBS, así no depende de su lista de servicios). */
const STREAM_SERVERS = {
  facebook: 'rtmps://live-api-s.facebook.com:443/rtmp/',
  youtube: 'rtmp://a.rtmp.youtube.com/live2',
};

// Tipos de fuente de OBS por plataforma.
const AUDIO_KINDS = ['coreaudio_input_capture', 'wasapi_input_capture', 'pulse_input_capture', 'alsa_input_capture'];
const VIDEO_DEVICE_KINDS = ['av_capture_input', 'av_capture_input_v2', 'macos_avcapture', 'macos_avcapture_fast', 'dshow_input', 'v4l2_input'];
const TEXT_KINDS = ['text_ft2_source', 'text_ft2_source_v2', 'text_gdiplus', 'text_gdiplus_v2', 'text_gdiplus_v3'];
const isNdiKind = (kind) => /ndi/i.test(kind || '');

class ObsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Respuesta a la autenticación: base64(sha256(base64(sha256(contraseña + sal)) + reto)). */
function authResponse(password, salt, challenge) {
  const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
  return crypto.createHash('sha256').update(secret + challenge).digest('base64');
}

class ObsClient {
  constructor({ WebSocketImpl = globalThis.WebSocket } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
    this.pending = new Map();
    this.handlers = new Map();
    this.nextId = 1;
    this.subscriptions = EVENTS_ALL;
    this.version = null;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === 1 && this.version !== null;
  }

  connect({ host = '127.0.0.1', port = 4455, password = '', timeout = 4000 } = {}) {
    this.close();
    if (!this.WebSocketImpl) return Promise.reject(new ObsError('NO_WEBSOCKET', 'Este sistema no tiene WebSocket disponible.'));

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.close();
          reject(err);
        } else resolve(value);
      };
      const timer = setTimeout(() => finish(new ObsError('TIMEOUT', 'OBS no respondió a tiempo.')), timeout);

      let ws;
      try {
        ws = new this.WebSocketImpl(`ws://${host}:${port}`);
      } catch (err) {
        finish(new ObsError('BAD_ADDRESS', `Dirección de OBS no válida: ${err.message}`));
        return;
      }
      this.ws = ws;

      ws.addEventListener('error', () => finish(new ObsError('UNREACHABLE', 'No se pudo conectar con OBS. ¿Está abierto y con el servidor WebSocket activado?')));
      ws.addEventListener('close', (e) => {
        if (e.code === 4009) finish(new ObsError('AUTH_FAILED', 'La contraseña del WebSocket de OBS no es correcta.'));
        else finish(new ObsError('CLOSED', `OBS cerró la conexión${e.reason ? `: ${e.reason}` : ''}.`));
        this.version = null;
        for (const { reject: rej } of this.pending.values()) rej(new ObsError('CLOSED', 'Se perdió la conexión con OBS.'));
        this.pending.clear();
      });
      ws.addEventListener('message', (e) => {
        let msg;
        try {
          msg = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
        } catch {
          return;
        }
        const { op, d } = msg;
        if (op === OP.HELLO) {
          const identify = { rpcVersion: 1, eventSubscriptions: this.subscriptions };
          if (d.authentication) {
            if (!password) {
              finish(new ObsError('AUTH_REQUIRED', 'OBS pide contraseña para el WebSocket. Escríbela en Configuración.'));
              return;
            }
            identify.authentication = authResponse(password, d.authentication.salt, d.authentication.challenge);
          }
          this.send(OP.IDENTIFY, identify);
        } else if (op === OP.IDENTIFIED) {
          this.version = d.negotiatedRpcVersion;
          finish(null, { rpcVersion: d.negotiatedRpcVersion });
        } else if (op === OP.RESPONSE) {
          const p = this.pending.get(d.requestId);
          if (!p) return;
          this.pending.delete(d.requestId);
          if (d.requestStatus.result) p.resolve(d.responseData || {});
          else p.reject(new ObsError(`REQUEST_${d.requestStatus.code}`, d.requestStatus.comment || `OBS rechazó ${p.type}.`));
        } else if (op === OP.EVENT) {
          for (const cb of this.handlers.get(d.eventType) || []) cb(d.eventData || {});
        }
      });
    });
  }

  send(op, d) {
    this.ws.send(JSON.stringify({ op, d }));
  }

  /**
   * Recién abierto, OBS acepta la conexión antes de terminar de cargar las escenas y responde
   * "no está listo" (207). Esas respuestas se reintentan durante unos segundos.
   */
  async request(requestType, requestData = {}, timeout = 8000) {
    const until = Date.now() + 20000;
    for (;;) {
      try {
        return await this.requestOnce(requestType, requestData, timeout);
      } catch (err) {
        if (err.code !== 'REQUEST_207' || Date.now() > until) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  requestOnce(requestType, requestData = {}, timeout = 8000) {
    if (!this.connected) return Promise.reject(new ObsError('NOT_CONNECTED', 'No hay conexión con OBS.'));
    const requestId = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ObsError('TIMEOUT', `OBS no respondió a ${requestType}.`));
      }, timeout);
      this.pending.set(requestId, {
        type: requestType,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send(OP.REQUEST, { requestType, requestId, requestData });
    });
  }

  on(eventType, cb) {
    if (!this.handlers.has(eventType)) this.handlers.set(eventType, new Set());
    this.handlers.get(eventType).add(cb);
    return () => this.handlers.get(eventType).delete(cb);
  }

  /** Activa o desactiva los medidores de volumen sin reconectar. */
  setMeters(enabled) {
    this.subscriptions = enabled ? EVENTS_ALL | EVENTS_METERS : EVENTS_ALL;
    if (this.connected) this.send(OP.REIDENTIFY, { eventSubscriptions: this.subscriptions });
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ya estaba cerrado */
      }
    }
    this.ws = null;
    this.version = null;
  }
}

/* ------------------------------------------------------------------ */
/* Consultas de alto nivel                                             */
/* ------------------------------------------------------------------ */

/** Nombre legible del dispositivo que usa una fuente (las listas de OBS traen nombre y valor). */
async function deviceName(obs, inputName, propertyName, value) {
  try {
    const { propertyItems } = await obs.request('GetInputPropertiesListPropertyItems', { inputName, propertyName });
    const item = propertyItems.find((i) => i.itemValue === value);
    return item ? item.itemName : '';
  } catch {
    return '';
  }
}

/** Fuentes de audio de entrada con el dispositivo que usa cada una. */
async function audioInputs(obs) {
  const { inputs } = await obs.request('GetInputList');
  const out = [];
  for (const input of inputs.filter((i) => AUDIO_KINDS.includes(i.inputKind))) {
    const { inputSettings } = await obs.request('GetInputSettings', { inputName: input.inputName });
    const deviceId = inputSettings.device_id || 'default';
    const name = deviceId === 'default' ? '' : await deviceName(obs, input.inputName, 'device_id', deviceId);
    const { inputMuted } = await obs.request('GetInputMute', { inputName: input.inputName }).catch(() => ({ inputMuted: false }));
    out.push({ inputName: input.inputName, inputKind: input.inputKind, deviceId, deviceName: name, isDefault: deviceId === 'default', muted: inputMuted });
  }
  return out;
}

/** Dispositivos de audio que OBS puede usar (lista de una fuente de audio de entrada). */
async function audioDevices(obs, inputName) {
  const { propertyItems } = await obs.request('GetInputPropertiesListPropertyItems', { inputName, propertyName: 'device_id' });
  return propertyItems.filter((i) => i.itemValue && i.itemValue !== 'default').map((i) => ({ name: i.itemName, id: i.itemValue }));
}

/** Fuentes NDI configuradas en OBS y a qué emisor apunta cada una. */
async function ndiInputs(obs) {
  const { inputs } = await obs.request('GetInputList');
  const out = [];
  for (const input of inputs.filter((i) => isNdiKind(i.inputKind))) {
    const { inputSettings } = await obs.request('GetInputSettings', { inputName: input.inputName });
    out.push({ inputName: input.inputName, inputKind: input.inputKind, ndiName: inputSettings.ndi_source_name || '' });
  }
  return out;
}

/** Emisores NDI que OBS ve en la red (se consulta la lista de una fuente NDI existente). */
async function ndiNetworkSources(obs, inputName) {
  try {
    const { propertyItems } = await obs.request('GetInputPropertiesListPropertyItems', { inputName, propertyName: 'ndi_source_name' });
    return propertyItems.map((i) => i.itemValue || i.itemName).filter(Boolean);
  } catch {
    return [];
  }
}

/** Fuentes de video locales (capturadoras, cámaras USB) con el dispositivo de cada una. */
async function videoDeviceInputs(obs) {
  const { inputs } = await obs.request('GetInputList');
  const out = [];
  for (const input of inputs.filter((i) => VIDEO_DEVICE_KINDS.includes(i.inputKind))) {
    const { inputSettings } = await obs.request('GetInputSettings', { inputName: input.inputName });
    const value = inputSettings.device || inputSettings.video_device_id || inputSettings.device_id || '';
    const prop = 'device' in inputSettings ? 'device' : 'video_device_id' in inputSettings ? 'video_device_id' : 'device_id';
    out.push({ inputName: input.inputName, inputKind: input.inputKind, device: inputSettings.device_name || (await deviceName(obs, input.inputName, prop, value)) });
  }
  return out;
}

/** Nivel máximo (dBFS) de cada fuente de audio durante `ms` milisegundos. */
function measureLevels(obs, ms = 5000) {
  return new Promise((resolve) => {
    const peaks = {};
    const off = obs.on('InputVolumeMeters', ({ inputs }) => {
      for (const input of inputs || []) {
        // inputLevelsMul: por canal [magnitud, pico, pico de entrada] en escala lineal.
        const peak = Math.max(0, ...(input.inputLevelsMul || []).map((ch) => ch[1] || 0));
        peaks[input.inputName] = Math.max(peaks[input.inputName] || 0, peak);
      }
    });
    obs.setMeters(true);
    setTimeout(() => {
      off();
      obs.setMeters(false);
      const db = {};
      for (const [name, mul] of Object.entries(peaks)) db[name] = mul > 0 ? Math.round(20 * Math.log10(mul) * 10) / 10 : -Infinity;
      resolve(db);
    }, ms);
  });
}

/** Configuración de transmisión actual de OBS, sin exponer la clave completa. */
async function streamTarget(obs) {
  const { streamServiceType, streamServiceSettings = {} } = await obs.request('GetStreamServiceSettings');
  return {
    type: streamServiceType,
    service: streamServiceSettings.service || '',
    server: streamServiceSettings.server || '',
    key: streamServiceSettings.key || '',
  };
}

/** Deja la transmisión de OBS apuntando a `server` con `key` (modo "Personalizado"). */
function setStreamTarget(obs, server, key) {
  return obs.request('SetStreamServiceSettings', {
    streamServiceType: 'rtmp_custom',
    streamServiceSettings: { server, key, use_auth: false },
  });
}

/** Fuentes de una escena (incluye las de grupos), con si están visibles. */
async function sceneItems(obs, sceneName) {
  const { sceneItems: items } = await obs.request('GetSceneItemList', { sceneName });
  const out = [];
  for (const item of items) {
    out.push({ name: item.sourceName, kind: item.inputKind || '', enabled: item.sceneItemEnabled, group: !!item.isGroup });
    if (item.isGroup) {
      const { sceneItems: inner } = await obs.request('GetGroupSceneItemList', { sceneName: item.sourceName }).catch(() => ({ sceneItems: [] }));
      for (const i of inner) out.push({ name: i.sourceName, kind: i.inputKind || '', enabled: item.sceneItemEnabled && i.sceneItemEnabled, group: false });
    }
  }
  return out;
}

/** Texto de una fuente de texto de OBS. */
function setText(obs, inputName, value) {
  return obs.request('SetInputSettings', { inputName, inputSettings: { text: value }, overlay: true });
}

/** Busca un nombre dentro de otro sin distinguir mayúsculas ni acentos. */
function matches(haystack, needle) {
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const n = norm(needle);
  return n.length > 0 && norm(haystack).includes(n);
}

module.exports = {
  ObsClient, ObsError, authResponse, STREAM_SERVERS, AUDIO_KINDS, VIDEO_DEVICE_KINDS, TEXT_KINDS, isNdiKind,
  audioInputs, audioDevices, ndiInputs, ndiNetworkSources, videoDeviceInputs, measureLevels,
  streamTarget, setStreamTarget, sceneItems, setText, matches,
};
