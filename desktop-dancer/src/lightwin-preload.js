const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('light', {
  get: () => ipcRenderer.invoke('light:get'),
  set: (patch) => ipcRenderer.invoke('light:set', patch),
});
