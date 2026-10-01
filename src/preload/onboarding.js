'use strict';
/** Preload bridge for the onboarding window. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceos', {
  getConfig: () => ipcRenderer.invoke('voiceos:get-config'),
  status: () => ipcRenderer.invoke('voiceos:status'),
  apps: () => ipcRenderer.invoke('voiceos:apps'),
  setAppEnabled: (id, enabled) => ipcRenderer.invoke('voiceos:set-app-enabled', { id, enabled }),
  completeOnboarding: () => ipcRenderer.invoke('voiceos:complete-onboarding'),

  onSessionResult: (fn) => {
    const wrapped = (_e, payload) => fn(payload);
    ipcRenderer.on('session-result', wrapped);
    return () => ipcRenderer.removeListener('session-result', wrapped);
  }
});
