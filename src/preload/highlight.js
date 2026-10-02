'use strict';
/** Preload bridge for the cursor trail. Receive-only: it never acts. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceos', {
  onPoint: (fn) => {
    const wrapped = (_e, payload) => fn(payload);
    ipcRenderer.on('trail-point', wrapped);
    return () => ipcRenderer.removeListener('trail-point', wrapped);
  }
});
