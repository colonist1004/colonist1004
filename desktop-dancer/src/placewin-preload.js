const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('place', {
  get: () => ipcRenderer.invoke('place:get'),
  set: (patch) => ipcRenderer.invoke('place:set', patch),
  reset: () => ipcRenderer.invoke('place:reset'),
  onChanged: (cb) => ipcRenderer.on('place:changed', (_e, v) => cb(v)),
});
