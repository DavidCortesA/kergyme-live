const { contextBridge, ipcRenderer } = require('electron');

/**
 * Puente seguro entre la interfaz y el proceso principal.
 * La interfaz solo puede llamar a estas funciones; no tiene acceso a Node ni a las claves.
 */
const listen = (channel) => (callback) => {
  const listener = (_e, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('kerygma', {
  init: () => ipcRenderer.invoke('app:init'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  setSecret: (name, value) => ipcRenderer.invoke('secrets:set', name, value),
  runCheck: (id, opts) => ipcRenderer.invoke('checks:run', id, opts),
  prepare: (devices) => ipcRenderer.invoke('checks:prepare', devices),
  action: (id, actionId, devices) => ipcRenderer.invoke('checks:action', id, actionId, devices),
  setService: (serviceId) => ipcRenderer.invoke('checks:service', serviceId),
  resetChecks: () => ipcRenderer.invoke('checks:reset'),
  startStream: () => ipcRenderer.invoke('stream:start'),
  showPatterns: () => ipcRenderer.invoke('patterns:show'),
  scanObs: () => ipcRenderer.invoke('obs:scan'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onCheckUpdate: listen('checks:update'),
});
