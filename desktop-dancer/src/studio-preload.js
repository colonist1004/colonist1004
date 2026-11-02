const { contextBridge, ipcRenderer, webUtils } = require('electron');

const subscribe = (channel, cb) => {
  const h = (_e, v) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('studio', {
  status: () => ipcRenderer.invoke('studio:status'),
  setup: () => ipcRenderer.invoke('studio:setup'),
  onSetupLog: (cb) => subscribe('studio:setup-log', cb),
  openPythonDownload: () => ipcRenderer.invoke('studio:open-python'),
  openLink: (url) => ipcRenderer.invoke('studio:open-link', url),
  pathForFile: (file) => webUtils.getPathForFile(file),
  download: (url) => ipcRenderer.invoke('studio:download', url),
  readVideo: (p) => ipcRenderer.invoke('studio:read-video', p),
  pickGvhmr: () => ipcRenderer.invoke('studio:pick-gvhmr'),
  run: (opts) => ipcRenderer.invoke('studio:run', opts),
  onJob: (cb) => subscribe('studio:job', cb),
  cancel: () => ipcRenderer.invoke('studio:cancel'),
  apply: (p) => ipcRenderer.invoke('studio:apply', p),
  openFolder: () => ipcRenderer.invoke('studio:open-folder'),
});
