/**
 * Pruebas de red: red local, conexión a internet, latencia y velocidad.
 * La velocidad se mide contra speed.cloudflare.com, sin cuenta ni clave.
 */
const os = require('os');

const SPEED = 'https://speed.cloudflare.com';

/** Primera dirección IPv4 de la red local (NDI y OBS la necesitan), o null. */
function localAddress(interfaces = os.networkInterfaces()) {
  for (const [name, list] of Object.entries(interfaces)) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) return { name, address: a.address };
    }
  }
  return null;
}

async function timed(url, init = {}, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const start = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
    const body = await res.arrayBuffer();
    return { ok: res.ok || res.status < 500, status: res.status, ms: performance.now() - start, bytes: body.byteLength };
  } finally {
    clearTimeout(timer);
  }
}

/** ¿Responden los sitios de transmisión? Devuelve { ok, sites: [{ host, ok }] }. */
async function reachable(hosts = ['https://www.facebook.com', 'https://www.youtube.com', SPEED]) {
  const sites = await Promise.all(
    hosts.map(async (h) => {
      try {
        const r = await timed(h, { method: 'HEAD' }, 6000);
        return { host: new URL(h).hostname, ok: r.ok };
      } catch {
        return { host: new URL(h).hostname, ok: false };
      }
    })
  );
  return { ok: sites.some((s) => s.ok), sites };
}

/** Latencia mediana en ms (5 peticiones vacías). */
async function latency(samples = 5) {
  const times = [];
  for (let i = 0; i < samples; i++) {
    try {
      times.push((await timed(`${SPEED}/__down?bytes=0`, {}, 4000)).ms);
    } catch {
      /* se ignora la muestra perdida */
    }
  }
  if (!times.length) return null;
  times.sort((a, b) => a - b);
  return Math.round(times[Math.floor(times.length / 2)]);
}

const mbps = (bytes, ms) => Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 10) / 10;

// Cloudflare rechaza descargas de más de 10 MB (403).
async function download(bytes = 10e6) {
  const r = await timed(`${SPEED}/__down?bytes=${bytes}`, {}, 30000);
  if (r.status !== 200 || !r.bytes) throw new Error(`Respuesta ${r.status}`);
  return mbps(r.bytes, r.ms);
}

/** Subida: lo que de verdad importa para transmitir. */
async function upload(bytes = 6e6) {
  const body = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 4096) body[i] = (i / 4096) & 0xff;
  const r = await timed(`${SPEED}/__up`, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } }, 40000);
  if (r.status !== 200) throw new Error(`Respuesta ${r.status}`);
  return mbps(bytes, r.ms);
}

/** Subida recomendada para un bitrate de OBS: 1.5 veces el video + audio, con margen. */
const recommendedUpload = (bitrateKbps) => Math.round(((bitrateKbps + 160) * 1.5) / 100) / 10;

module.exports = { localAddress, reachable, latency, download, upload, recommendedUpload };
