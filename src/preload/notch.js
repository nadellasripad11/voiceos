'use strict';
/**
 * Preload bridge for the notch overlay.
 *
 * contextIsolation is on and nodeIntegration is off, so the renderer gets only
 * this explicit surface rather than access to Node.
 */
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('voiceos', {
  getConfig: () => ipcRenderer.invoke('voiceos:get-config'),
  cancel: () => ipcRenderer.invoke('voiceos:cancel'),
  requestIdle: () => ipcRenderer.send('voiceos:request-idle'),
  openSettings: () => ipcRenderer.invoke('voiceos:open-settings'),

  // PCM is passed as a transferable ArrayBuffer to keep the payload compact.
  submitAudio: ({ pcm, sampleRate, mode }) =>
    ipcRenderer.invoke('voiceos:submit-audio', { pcm, sampleRate, mode }),

  reportLevel: (level) => ipcRenderer.send('voiceos:level', level),
  setInteractive: (v) => ipcRenderer.send('voiceos:notch-interactive', v),
  startMode: (mode) => ipcRenderer.send('voiceos:start-mode', mode),

  insertText: (text) => ipcRenderer.invoke('voiceos:insert-text', text),
  copyText: (text) => ipcRenderer.invoke('voiceos:copy-text', text),
  resolveConfirm: (payload) => ipcRenderer.invoke('voiceos:resolve-confirm', payload),

  onSessionIdle: (fn) => on('session-idle', fn),
  onSessionStart: (fn) => on('session-start', fn),
  onSessionStop: (fn) => on('session-stop', fn),
  onSessionCancel: (fn) => on('session-cancel', fn),
  onSessionStage: (fn) => on('session-stage', fn),
  onSessionResult: (fn) => on('session-result', fn),
  onAgentResult: (fn) => on('agent-result', fn),
  onSpeak: (fn) => on('speak', fn),
  onSessionError: (fn) => on('session-error', fn)
});
