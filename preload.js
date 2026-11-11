const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudio', {
  clips: () => ipcRenderer.invoke('clips'),
  clipPcm: (id) => ipcRenderer.invoke('clip-pcm', id),
  saveClip: (id) => ipcRenderer.invoke('save-clip', id),
  revealClip: (id) => ipcRenderer.invoke('reveal-clip', id),
  renameClip: (id, title) => ipcRenderer.invoke('rename-clip', id, title),
  deleteClip: (id) => ipcRenderer.invoke('delete-clip', id),
  claude: (action, windowTitle) => ipcRenderer.invoke('claude', action, windowTitle),
  hide: () => ipcRenderer.send('hide'),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, data) => fn(data)),
});
