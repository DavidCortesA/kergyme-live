/**
 * Configuración del servidor WebSocket de OBS, leída del propio archivo de OBS:
 *   macOS    ~/Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json
 *   Windows  %APPDATA%\obs-studio\plugin_config\obs-websocket\config.json
 *   Linux    ~/.config/obs-studio/plugin_config/obs-websocket/config.json
 *
 * Así la app se conecta sin pedir la contraseña, y puede activar el servidor si está apagado
 * (solo con OBS cerrado: OBS reescribe este archivo al salir).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function obsConfigDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'obs-studio');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'obs-studio');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'obs-studio');
}

const websocketFile = (dir = obsConfigDir()) => path.join(dir, 'plugin_config', 'obs-websocket', 'config.json');

/** { exists, enabled, port, authRequired, password } — `password` nunca sale hacia la interfaz. */
function readWebsocket(file = websocketFile()) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      exists: true,
      enabled: !!d.server_enabled,
      port: Number(d.server_port) || 4455,
      authRequired: !!d.auth_required,
      password: d.server_password || '',
    };
  } catch {
    return { exists: false, enabled: false, port: 4455, authRequired: false, password: '' };
  }
}

/**
 * Activa el servidor WebSocket conservando el puerto y la contraseña existentes.
 * Si no hay contraseña, genera una (OBS la muestra en Herramientas → Ajustes del servidor WebSocket).
 */
function enableWebsocket(file = websocketFile()) {
  let d = {};
  try {
    d = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* OBS nunca abrió el plugin: se crea el archivo */
  }
  d.server_enabled = true;
  d.server_port = Number(d.server_port) || 4455;
  if (!d.server_password) d.server_password = crypto.randomBytes(12).toString('base64url');
  d.auth_required = true;
  if (d.first_load === undefined) d.first_load = false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(d, null, 4));
  return readWebsocket(file);
}

module.exports = { obsConfigDir, websocketFile, readWebsocket, enableWebsocket };
