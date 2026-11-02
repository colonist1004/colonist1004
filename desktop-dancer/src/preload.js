const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dancer', {
  getInitial: () => ipcRenderer.invoke('get-initial'),
  readAsset: (file) => ipcRenderer.invoke('read-asset', file),
  setHover: (hovering) => ipcRenderer.send('set-hover', hovering),
  drag: (phase, screenX) => ipcRenderer.send('drag', phase, screenX),
  reportError: (msg) => ipcRenderer.send('renderer-error', String(msg)),
  onLoad: (cb) => ipcRenderer.on('load', (_e, v) => cb(v)),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, v) => cb(v)),
});
