const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  // snip selector window
  onShot: (cb) => on('snip:shot', cb),
  snipDone: (dataUrl) => ipcRenderer.send('snip:done', dataUrl),
  snipCancel: () => ipcRenderer.send('snip:cancel'),

  // panel window
  startSnip: () => ipcRenderer.send('snip:start'),
  hidePanel: () => ipcRenderer.send('panel:hide'),
  extractImage: (dataUrl) => ipcRenderer.invoke('image:extract', dataUrl),
  onJobStart: (cb) => on('job:start', cb),
  onJobDone: (cb) => on('job:done', cb),
  onJobError: (cb) => on('job:error', cb),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),

  summarize: (payload) => ipcRenderer.invoke('action:summarize', payload),
  ask: (payload) => ipcRenderer.invoke('action:ask', payload),

  listLibrary: () => ipcRenderer.invoke('library:list'),
  searchLibrary: (q) => ipcRenderer.invoke('library:search', q),
  getEntry: (id) => ipcRenderer.invoke('library:get', id),
  deleteEntry: (id) => ipcRenderer.invoke('library:delete', id),

  copy: (text) => ipcRenderer.invoke('clipboard:copy', text),
});
