/**
 * electron-builder lo ejecuta tras empaquetar y ANTES de firmar.
 * En carpetas sincronizadas con iCloud (Documentos/Escritorio) macOS agrega atributos
 * extendidos a los archivos y `codesign` falla con "resource fork, Finder information,
 * or similar detritus not allowed". Se eliminan antes de firmar.
 */
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  execFileSync('xattr', ['-cr', context.appOutDir]);
};
