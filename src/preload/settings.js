'use strict';
/** Preload bridge for the settings, app store and history windows. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceos', {
  getConfig: () => ipcRenderer.invoke('voiceos:get-config'),
  setConfig: (patch) => ipcRenderer.invoke('voiceos:set-config', patch),
  setValue: (key, value) => ipcRenderer.invoke('voiceos:set-config-value', { key, value }),
  resetConfig: () => ipcRenderer.invoke('voiceos:reset-config'),
  status: () => ipcRenderer.invoke('voiceos:status'),

  transcripts: (args) => ipcRenderer.invoke('voiceos:transcripts', args),
  credentials: (args) => ipcRenderer.invoke('voiceos:credentials', args),
  openPath: (which) => ipcRenderer.invoke('voiceos:open-path', which),
  previewVoice: (text) => ipcRenderer.invoke('voiceos:preview-voice', text),
  apps: () => ipcRenderer.invoke('voiceos:apps'),
  connections: () => ipcRenderer.invoke('voiceos:connections'),
  openExternal: (url) => ipcRenderer.invoke('voiceos:open-external', url),
  connect: (provider, input) => ipcRenderer.invoke('voiceos:connect', { provider, input }),
  disconnect: (provider, accountId) => ipcRenderer.invoke('voiceos:disconnect', { provider, accountId }),
  setOauthClient: (provider, clientId, clientSecret) =>
    ipcRenderer.invoke('voiceos:set-oauth-client', { provider, clientId, clientSecret }),
  setAppAccount: (appId, key) => ipcRenderer.invoke('voiceos:set-app-account', { appId, key }),
  pickFolder: (multiple) => ipcRenderer.invoke('voiceos:pick-folder', { multiple }),
  setAppEnabled: (id, enabled) => ipcRenderer.invoke('voiceos:set-app-enabled', { id, enabled }),

  onSpeak: (fn) => {
    const wrapped = (_e, payload) => fn(payload);
    ipcRenderer.on('speak', wrapped);
    return () => ipcRenderer.removeListener('speak', wrapped);
  },
  onLevel: (fn) => {
    const wrapped = (_e, level) => fn(level);
    ipcRenderer.on('voiceos:level', wrapped);
    return () => ipcRenderer.removeListener('voiceos:level', wrapped);
  },
  onSettingsChanged: (fn) => {
    const wrapped = (_e, cfg) => fn(cfg);
    ipcRenderer.on('settings-changed', wrapped);
    return () => ipcRenderer.removeListener('settings-changed', wrapped);
  }
});
