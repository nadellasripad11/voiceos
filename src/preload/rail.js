'use strict';
/** Preload bridge for the left-edge history rail. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceos', {
  // Lets the renderer hand mouse input back and forth, so the rail only
  // intercepts clicks while something is actually on screen to click.
  setInteractive: (interactive) => ipcRenderer.send('voiceos:rail-interactive', interactive),

  transcripts: (args) => ipcRenderer.invoke('voiceos:transcripts', args),
  copyText: (text) => ipcRenderer.invoke('voiceos:copy-text', text),
  openSettings: () => ipcRenderer.invoke('voiceos:open-settings'),

  onHistoryChanged: (fn) => {
    const wrapped = () => fn();
    ipcRenderer.on('history-changed', wrapped);
    return () => ipcRenderer.removeListener('history-changed', wrapped);
  }
});
