'use strict';
/** Preload bridge for the targeting overlay. Receive-only: it never acts. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceos', {
  onTarget: (fn) => {
    const wrapped = (_e, payload) => fn(payload);
    ipcRenderer.on('highlight-target', wrapped);
    return () => ipcRenderer.removeListener('highlight-target', wrapped);
  }
});
