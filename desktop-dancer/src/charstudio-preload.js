const { contextBridge, ipcRenderer, webUtils } = require('electron');

const subscribe = (channel, cb) => {
  const h = (_e, v) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('charStudio', {
  status: () => ipcRenderer.invoke('studio:status'),
  setup: () => ipcRenderer.invoke('char:setup'),
  onSetupLog: (cb) => subscribe('char:setup-log', cb),
  openPythonDownload: () => ipcRenderer.invoke('studio:open-python'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  checkImage: (p) => ipcRenderer.invoke('char:check-image', p),
  convert: (opts) => ipcRenderer.invoke('char:convert', opts),
  importVrm: (p) => ipcRenderer.invoke('char:import-vrm', p),
  onJob: (cb) => subscribe('char:job', cb),
  readLibraryFile: (p) => ipcRenderer.invoke('char:read-library-file', p),
  readSampleMotion: () => ipcRenderer.invoke('char:read-sample-motion'),
  openCloudFolder: () => ipcRenderer.invoke('char:open-cloud-folder'),
  apply: (p) => ipcRenderer.invoke('char:apply', p),
});
