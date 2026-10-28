/**
 * Evalúa las pantallas conectadas contra las que la computadora debería tener.
 * Recibe la lista de pantallas de Electron (screen.getAllDisplays) ya simplificada,
 * así se puede probar sin Electron.
 */
const { OUTPUT_ROLE } = require('./checklist');

/** En macOS, `system_profiler SPDisplaysDataType` dice "Mirror: On" si hay pantallas en espejo. */
const macMirrored = (profilerText) => /Mirror:\s*On/i.test(profilerText || '');

/**
 * displays: [{ id, label, width, height, primary, internal }]
 * outputs:  [{ role, name }] — pantallas de salida esperadas (sin contar la del operador)
 */
function assess(displays, outputs, mirrored = false) {
  const extra = displays.filter((d) => !d.primary);
  const notes = [];
  for (const d of extra) {
    const ratio = d.width / d.height;
    if (d.width < 1280 || d.height < 720) notes.push(`${d.label}: ${d.width}×${d.height} es baja para proyectar; usa 1280×720 o más.`);
    else if (Math.abs(ratio - 16 / 9) > 0.05 && Math.abs(ratio - 16 / 10) > 0.05) notes.push(`${d.label}: ${d.width}×${d.height} no es panorámica; la presentación puede verse con barras.`);
  }

  if (mirrored) {
    return { status: 'error', message: 'Las pantallas están en espejo: la presentación se vería también en tu monitor. Activa el escritorio extendido.', notes, extra };
  }
  const missing = outputs.length - extra.length;
  if (missing > 0) {
    const names = outputs.slice(extra.length).map((o) => o.name || OUTPUT_ROLE[o.role]).join(', ');
    return { status: 'error', message: `Falta${missing === 1 ? '' : 'n'} ${missing} pantalla${missing === 1 ? '' : 's'} (${names}). Revisa el cable o el receptor y que esté encendida.`, notes, extra };
  }
  if (missing < 0) {
    return { status: 'warn', message: `Hay ${extra.length} pantallas extra conectadas y se esperaban ${outputs.length}. Confirma cuál es cuál con la prueba de imagen.`, notes, extra };
  }
  return { status: notes.length ? 'warn' : 'ok', message: `${extra.length} pantalla${extra.length === 1 ? '' : 's'} de salida conectada${extra.length === 1 ? '' : 's'}, escritorio extendido.`, notes, extra };
}

module.exports = { macMirrored, assess };
