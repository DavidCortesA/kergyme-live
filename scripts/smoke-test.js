#!/usr/bin/env node
/**
 * Pruebas sin conexión: configuración, checklist, títulos, páginas, pantallas, red y el cliente
 * de OBS WebSocket contra un OBS simulado (no toca el OBS real ni internet).
 *
 * Uso:  npm test
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const settings = require('../src/core/settings');
const { checklist, summarize, serviceFor, serviceTitle } = require('../src/core/checklist');
const obsApi = require('../src/core/obs');
const obsConfig = require('../src/core/obs-config');
const browser = require('../src/core/browser');
const displays = require('../src/core/displays');
const network = require('../src/core/network');
const apps = require('../src/core/apps');

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (err) {
    failed++;
    console.error(`✘ ${name}\n  ${err.stack || err}`);
  }
}

/* ------------------------------------------------------------------ */
/* OBS simulado: habla el protocolo 5 con autenticación                */
/* ------------------------------------------------------------------ */
function fakeObs(password) {
  const salt = crypto.randomBytes(8).toString('base64');
  const challenge = crypto.randomBytes(8).toString('base64');
  const expected = crypto.createHash('sha256').update(crypto.createHash('sha256').update(password + salt).digest('base64') + challenge).digest('base64');
  const obs = {
    stream: { streamServiceType: 'rtmp_common', streamServiceSettings: { service: 'YouTube - RTMPS', server: 'auto', key: 'vieja' } },
    inputs: {
      'Mic/Aux': { kind: 'coreaudio_input_capture', settings: { device_id: 'default' }, muted: false },
      Consola: { kind: 'coreaudio_input_capture', settings: { device_id: 'AppleUSB:maono' }, muted: false },
      'Letras (NDI)': { kind: 'ndi_source', settings: { ndi_source_name: 'HOLYRICS-PC (Holyrics)' } },
      Título: { kind: 'text_ft2_source_v2', settings: { text: 'Otro' } },
    },
    devices: [{ itemName: 'Predeterminado', itemValue: 'default' }, { itemName: 'MAONO AU-AM200', itemValue: 'AppleUSB:maono' }, { itemName: 'MacBook Pro Micrófono', itemValue: 'BuiltIn' }],
    ndiNetwork: ['HOLYRICS-PC (Holyrics)', 'IPHONE-JUAN (NDI HX Camera)'],
    requests: [],
  };
  const server = new WebSocketServer({ port: 0 });
  server.on('connection', (ws) => {
    ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1, authentication: { salt, challenge } } }));
    ws.on('message', (raw) => {
      const { op, d } = JSON.parse(raw);
      if (op === 1) {
        if (d.authentication !== expected) return ws.close(4009, 'Authentication failed.');
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (op === 3) {
        if (d.eventSubscriptions & (1 << 16)) {
          const send = (mul) => ws.send(JSON.stringify({ op: 5, d: { eventType: 'InputVolumeMeters', eventIntent: 1 << 16, eventData: { inputs: [{ inputName: 'Consola', inputLevelsMul: [[0.2, mul, mul]] }] } } }));
          setTimeout(() => send(0.25), 20);
          setTimeout(() => send(0.5), 60);
        }
        return;
      }
      if (op !== 6) return;
      obs.requests.push(d.requestType);
      const ok = (responseData = {}) => ws.send(JSON.stringify({ op: 7, d: { requestType: d.requestType, requestId: d.requestId, requestStatus: { result: true, code: 100 }, responseData } }));
      const fail = (code, comment) => ws.send(JSON.stringify({ op: 7, d: { requestType: d.requestType, requestId: d.requestId, requestStatus: { result: false, code, comment } } }));
      const rd = d.requestData || {};
      switch (d.requestType) {
        case 'GetVersion': return ok({ obsVersion: '32.0.0', obsWebSocketVersion: '5.5.0' });
        case 'GetInputList': return ok({ inputs: Object.entries(obs.inputs).map(([inputName, i]) => ({ inputName, inputKind: i.kind })) });
        case 'GetInputSettings': return obs.inputs[rd.inputName] ? ok({ inputSettings: obs.inputs[rd.inputName].settings, inputKind: obs.inputs[rd.inputName].kind }) : fail(600, 'No source was found');
        case 'GetInputMute': return ok({ inputMuted: obs.inputs[rd.inputName].muted });
        case 'SetInputMute': obs.inputs[rd.inputName].muted = rd.inputMuted; return ok();
        case 'SetInputSettings': Object.assign(obs.inputs[rd.inputName].settings, rd.inputSettings); return ok();
        case 'GetInputPropertiesListPropertyItems':
          if (rd.propertyName === 'device_id') return ok({ propertyItems: obs.devices.map((x) => ({ ...x, itemEnabled: true })) });
          if (rd.propertyName === 'ndi_source_name') return ok({ propertyItems: obs.ndiNetwork.map((n) => ({ itemName: n, itemValue: n, itemEnabled: true })) });
          return fail(600, 'No property');
        case 'GetStreamServiceSettings': return ok(obs.stream);
        case 'SetStreamServiceSettings': obs.stream = { streamServiceType: rd.streamServiceType, streamServiceSettings: rd.streamServiceSettings }; return ok();
        case 'GetSceneItemList': return ok({ sceneItems: [{ sourceName: 'Cámara', sceneItemEnabled: true }, { sourceName: 'Letras (NDI)', sceneItemEnabled: false }] });
        default: return fail(204, `Unknown request ${d.requestType}`);
      }
    });
  });
  return new Promise((resolve) => server.on('listening', () => resolve({ server, port: server.address().port, obs })));
}

(async () => {
  await test('configuración: valores de fábrica y limpieza de lo que llega de la interfaz', () => {
    const d = settings.effective({});
    assert.strictEqual(d.mode, null);
    assert.strictEqual(d.transmission.software, 'obs');
    const clean = settings.sanitize({
      mode: 'hacker', theme: 'light', org: '  Montaña de Dios  ',
      transmission: {
        destination: 'facebook', pageUrl: 'facebook.com/MontanadeDios', server: 'javascript:alert(1)', bitrateKbps: 999999,
        cameras: [{ name: 'Celular 1', type: 'ndi', source: 'IPHONE' }, { name: '', type: 'ndi' }, { name: 'X', type: 'raro' }],
        audio: { device: 'MAONO', required: 'sí' },
      },
      services: [{ name: 'Domingo', weekday: 0, title: 'Culto' }, { name: 'Mal', weekday: 9 }],
      screen: { outputs: [{ role: 'projector', name: 'Proyector' }, { role: 'pared' }], apiPort: 50001 },
    });
    assert.strictEqual(clean.mode, undefined);
    assert.strictEqual(clean.org, 'Montaña de Dios');
    assert.strictEqual(clean.transmission.pageUrl, 'https://facebook.com/MontanadeDios');
    assert.strictEqual(clean.transmission.server, undefined);
    assert.strictEqual(clean.transmission.bitrateKbps, undefined);
    assert.strictEqual(clean.transmission.cameras.length, 1);
    assert.strictEqual(clean.transmission.audio.required, undefined);
    assert.deepStrictEqual(clean.services.map((s) => s.weekday), [0, null]);
    assert.strictEqual(clean.screen.outputs.length, 1);
    assert.strictEqual(settings.sanitize({ transmission: { pageUrl: 'file:///etc/passwd' } }).transmission.pageUrl, undefined);
    const merged = settings.merge(d, settings.sanitize({ transmission: { audio: { device: 'MAONO' } } }));
    assert.strictEqual(merged.transmission.audio.device, 'MAONO');
    assert.strictEqual(merged.transmission.audio.type, 'usb-console');
  });

  await test('checklist de transmisión según el equipo (OBS, Safari, NDI, cámaras)', () => {
    const s = settings.effective({
      mode: 'transmission',
      transmission: { software: 'obs', browser: 'safari', lyrics: { enabled: true, source: 'Holyrics' }, cameras: [{ name: 'Celular 1', type: 'ndi' }, { name: 'Capturadora', type: 'capture' }] },
    });
    const ids = checklist(s).map((i) => i.id);
    assert.deepStrictEqual(ids, ['internet', 'software', 'page', 'streamkey', 'audio', 'lyrics', 'cameras', 'scenes', 'title']);
    assert.match(checklist(s).find((i) => i.id === 'cameras').subtitle, /1 por NDI · 1 por cable/);

    const other = settings.effective({ mode: 'transmission', transmission: { software: 'streamlabs', browser: 'none' } });
    assert.deepStrictEqual(checklist(other).map((i) => i.id), ['internet', 'software', 'audio', 'title']);
  });

  await test('checklist de pantalla y resumen (omitido no bloquea, obligatorio sí)', () => {
    const s = settings.effective({ mode: 'screen', screen: { software: 'propresenter', ndiOut: true } });
    const items = checklist(s);
    assert.deepStrictEqual(items.map((i) => i.id), ['presenter', 'displays', 'identify', 'output', 'ndiout', 'network']);
    const all = Object.fromEntries(items.map((i) => [i.id, { status: 'ok' }]));
    assert.strictEqual(summarize(items, all).ready, true);
    assert.strictEqual(summarize(items, { ...all, network: { status: 'error' } }).ready, true, 'la red es opcional');
    assert.strictEqual(summarize(items, { ...all, output: { status: 'confirm' } }).ready, false);
    assert.strictEqual(summarize(items, { ...all, displays: { status: 'skipped' } }).done, items.length);
  });

  await test('servicio y título según el día', () => {
    const services = [{ id: 'domingo', name: 'Domingo', weekday: 0, title: '' }, { id: 'miercoles', name: 'Miércoles', weekday: 3, title: 'Reunión de oración' }];
    assert.strictEqual(serviceFor(services, new Date(2026, 9, 25)).id, 'domingo'); // domingo
    assert.strictEqual(serviceFor(services, new Date(2026, 9, 28)).id, 'miercoles');
    assert.strictEqual(serviceFor(services, new Date(2026, 9, 29)).id, 'domingo', 'sin coincidencia, el primero');
    assert.strictEqual(serviceTitle(services[0], 'Montaña de Dios'), 'Domingo | Montaña de Dios');
    assert.strictEqual(serviceTitle(services[1], 'Montaña de Dios'), 'Reunión de oración');
  });

  await test('página del navegador: Facebook, otra página, Productor en vivo y YouTube', () => {
    const page = 'https://www.facebook.com/MontanadeDios';
    assert.strictEqual(browser.pageMatches('https://www.facebook.com/montanadedios/live', page, 'facebook').ok, true);
    assert.strictEqual(browser.pageMatches('https://www.facebook.com/live/producer/?ref=x', page, 'facebook').where, 'producer');
    assert.strictEqual(browser.pageMatches('https://www.facebook.com/OtraIglesia', page, 'facebook').ok, false);
    assert.strictEqual(browser.pageMatches('https://www.google.com', page, 'facebook').ok, false);
    assert.strictEqual(browser.pageMatches('', page, 'facebook').ok, false);
    assert.strictEqual(browser.pageMatches('https://www.facebook.com/profile.php?id=42', 'https://facebook.com/profile.php?id=42', 'facebook').ok, true);
    assert.strictEqual(browser.pageMatches('https://studio.youtube.com/channel/x/livestreaming', '', 'youtube').ok, true);
    assert.strictEqual(browser.livePageFor('facebook'), 'https://www.facebook.com/live/producer/');
  });

  await test('pantallas: espejo, faltantes, extra y resolución', () => {
    const op = { id: 1, label: 'Integrada', width: 2560, height: 1600, primary: true };
    const proj = { id: 2, label: 'Proyector', width: 1920, height: 1080, primary: false };
    const outputs = [{ role: 'projector', name: 'Proyector' }];
    assert.strictEqual(displays.assess([op, proj], outputs).status, 'ok');
    assert.strictEqual(displays.assess([op], outputs).status, 'error');
    assert.match(displays.assess([op], outputs).message, /Proyector/);
    assert.strictEqual(displays.assess([op, proj], outputs, true).status, 'error');
    assert.strictEqual(displays.assess([op, proj, { ...proj, id: 3 }], outputs).status, 'warn');
    assert.strictEqual(displays.assess([op, { ...proj, width: 1024, height: 768 }], outputs).status, 'warn');
    assert.strictEqual(displays.macMirrored('Display Type: LCD\n  Mirror: On\n'), true);
    assert.strictEqual(displays.macMirrored('Mirror: Off'), false);
  });

  await test('red: dirección local y subida recomendada', () => {
    assert.deepStrictEqual(network.localAddress({ lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], en0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }] }), { name: 'en0', address: '192.168.1.20' });
    assert.strictEqual(network.localAddress({ en0: [{ family: 'IPv4', internal: false, address: '169.254.3.4' }] }), null);
    assert.strictEqual(network.recommendedUpload(6000), 9.2);
  });

  await test('WebSocket de OBS: leer y activar sin perder la contraseña', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-obs-'));
    const file = path.join(dir, 'plugin_config', 'obs-websocket', 'config.json');
    assert.strictEqual(obsConfig.readWebsocket(file).exists, false);
    const created = obsConfig.enableWebsocket(file);
    assert.strictEqual(created.enabled, true);
    assert.ok(created.password.length >= 12);
    fs.writeFileSync(file, JSON.stringify({ server_enabled: false, server_port: 4460, server_password: 'secreta', auth_required: true }));
    const again = obsConfig.enableWebsocket(file);
    assert.deepStrictEqual([again.enabled, again.port, again.password], [true, 4460, 'secreta']);
    assert.match(obsConfig.obsConfigDir('win32', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), /obs-studio$/);
  });

  await test('programas: rutas de Windows con variables de entorno', () => {
    assert.strictEqual(apps.expandEnv('%ProgramFiles%\\obs-studio', { ProgramFiles: 'C:\\Program Files' }), 'C:\\Program Files\\obs-studio');
    assert.ok(apps.CATALOG.obs && apps.CATALOG.holyrics && apps.CATALOG.propresenter);
  });

  await test('OBS simulado: autenticación, audio MAONO, NDI, clave y medidores', async () => {
    const { server, port, obs } = await fakeObs('clave-obs');
    const client = new obsApi.ObsClient();
    try {
      await assert.rejects(client.connect({ port, password: 'mala' }), (e) => e.code === 'AUTH_FAILED');
      await assert.rejects(client.connect({ port }), (e) => e.code === 'AUTH_REQUIRED');
      await client.connect({ port, password: 'clave-obs' });
      assert.strictEqual(client.connected, true);
      assert.strictEqual((await client.request('GetVersion')).obsVersion, '32.0.0');
      await assert.rejects(client.request('Inventado'), (e) => e.code === 'REQUEST_204');

      const audio = await obsApi.audioInputs(client);
      const maono = audio.find((a) => obsApi.matches(a.deviceName, 'maono'));
      assert.strictEqual(maono.inputName, 'Consola');
      assert.strictEqual(audio.find((a) => a.inputName === 'Mic/Aux').isDefault, true);

      const ndi = await obsApi.ndiInputs(client);
      assert.strictEqual(ndi[0].ndiName, 'HOLYRICS-PC (Holyrics)');
      assert.deepStrictEqual(await obsApi.ndiNetworkSources(client, ndi[0].inputName), obs.ndiNetwork);

      assert.strictEqual((await obsApi.streamTarget(client)).key, 'vieja');
      await obsApi.setStreamTarget(client, obsApi.STREAM_SERVERS.facebook, 'FB-123');
      const target = await obsApi.streamTarget(client);
      assert.deepStrictEqual([target.type, target.server, target.key], ['rtmp_custom', 'rtmps://live-api-s.facebook.com:443/rtmp/', 'FB-123']);

      await obsApi.setText(client, 'Título', 'Domingo | Montaña de Dios');
      assert.strictEqual(obs.inputs['Título'].settings.text, 'Domingo | Montaña de Dios');

      const items = await obsApi.sceneItems(client, 'Transmisión');
      assert.deepStrictEqual(items.map((i) => i.enabled), [true, false]);

      const levels = await obsApi.measureLevels(client, 200);
      assert.strictEqual(levels.Consola, -6, 'pico de 0.5 → −6 dB');
    } finally {
      client.close();
      server.close();
    }
  });

  await test('sin OBS abierto: error claro, sin colgarse', async () => {
    const client = new obsApi.ObsClient();
    await assert.rejects(client.connect({ port: 1, timeout: 3000 }), (e) => ['UNREACHABLE', 'CLOSED', 'TIMEOUT'].includes(e.code));
    assert.strictEqual(obsApi.matches('Montaña de Dios', 'montana'), true);
    assert.strictEqual(obsApi.matches('algo', ''), false);
  });

  console.log(failed ? `\n${failed} prueba(s) fallaron` : '\nTodo OK');
  process.exit(failed ? 1 : 0);
})();
