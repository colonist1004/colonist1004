const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dancer', {
  getInitial: () => ipcRenderer.invoke('get-initial'),
  readAsset: (file) => ipcRenderer.invoke('read-asset', file),
  setHover: (hovering) => ipcRenderer.send('set-hover', hovering),
  drag: (phase, screenX, screenY) => ipcRenderer.send('drag', phase, screenX, screenY),
  resizeBy: (factor) => ipcRenderer.send('resize-by', factor),
  onFrame: (cb) => ipcRenderer.on('frame', (_e, v) => cb(v)),
  reportError: (msg) => ipcRenderer.send('renderer-error', String(msg)),
  devFrame: (i, dataUrl) => ipcRenderer.send('dev-frame', i, dataUrl),
  devRecordDone: () => ipcRenderer.send('dev-record-done'),
  getCustom: (file) => ipcRenderer.invoke('custom:get', file),
  onCustom: (cb) => ipcRenderer.on('custom-updated', (_e, v) => cb(v)),
  onLoad: (cb) => ipcRenderer.on('load', (_e, v) => cb(v)),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, v) => cb(v)),
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, v) => cb(v)),
  onWalk: (cb) => ipcRenderer.on('walk', (_e, v) => cb(v)),
  setBusy: (busy) => ipcRenderer.send('busy', !!busy),
});
