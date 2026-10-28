/**
 * ¿De dónde viene el audio? Distingue el micrófono de la propia computadora de una entrada
 * externa (consola, interfaz, micrófono USB, capturadora…), sin pedir el nombre de ningún equipo.
 *
 *   macOS    system_profiler SPAudioDataType dice el "Transport" de cada dispositivo
 *            (Built-in = de la computadora, Virtual = Zoom/Teams/NDI…) y cuál es la entrada predeterminada.
 *   Windows  solo hay nombres: se reconocen los micrófonos integrados más comunes.
 */

// Nombres típicos de micrófonos integrados (respaldo cuando el sistema no dice el tipo).
const BUILTIN_NAME = /built-?in|integrad|internal|interno|macbook|imac|mac mini|mac studio|realtek|microphone array|matriz de micr|conexant|smart sound|high definition audio/i;

/** Dispositivos de `system_profiler SPAudioDataType`: [{ name, input, defaultInput, transport }]. */
function parseMacAudio(text) {
  const devices = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const head = line.match(/^ {8}(\S.*):\s*$/);
    if (head) {
      cur = { name: head[1], input: false, defaultInput: false, transport: '' };
      devices.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^\s+([^:]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'Input Channels' && Number(value) > 0) cur.input = true;
    else if (key === 'Default Input Device' && value === 'Yes') cur.defaultInput = true;
    else if (key === 'Transport') cur.transport = value;
  }
  return devices.filter((d) => d.input);
}

/**
 * Origen de un dispositivo por su nombre: 'computer' (integrado), 'virtual' (software) o 'external'.
 * `devices` es la lista del sistema si se conoce (macOS); si no, se usa el nombre.
 */
function origin(name, devices = []) {
  const d = devices.find((x) => x.name === name) || devices.find((x) => name && (x.name.includes(name) || name.includes(x.name)));
  if (d && d.transport) {
    if (/built-?in/i.test(d.transport)) return 'computer';
    if (/virtual|aggregate/i.test(d.transport)) return 'virtual';
    return 'external';
  }
  return BUILTIN_NAME.test(name || '') ? 'computer' : 'external';
}

/**
 * Clasifica las fuentes de audio de OBS.
 * inputs: [{ inputName, deviceName, isDefault, muted }] (de obs.audioInputs)
 * Una fuente con el dispositivo "Predeterminado" usa la entrada predeterminada del sistema: en macOS
 * se sabe cuál es; en Windows no, y se trata como de la computadora (es lo más común).
 */
function classifyInputs(inputs, devices = []) {
  const def = devices.find((d) => d.defaultInput);
  return inputs.map((i) => {
    const name = i.isDefault ? (def ? def.name : '') : i.deviceName;
    const from = i.isDefault && !def ? 'computer' : origin(name, devices);
    return { ...i, resolvedName: name || 'Predeterminado del sistema', origin: from };
  });
}

const ORIGIN_LABEL = { computer: 'de la computadora', virtual: 'virtual', external: 'externa' };

module.exports = { parseMacAudio, origin, classifyInputs, ORIGIN_LABEL, BUILTIN_NAME };
