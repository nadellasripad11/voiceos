'use strict';
/**
 * Preload bridge for the console window.
 *
 * The console is a reader, mostly. It watches everything the app broadcasts
 * and shows it; the only things it sends are the ones a person clicks.
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
  // --- asking ---
  getConfig: () => ipcRenderer.invoke('voiceos:get-config'),
  getStatus: () => ipcRenderer.invoke('voiceos:console-status'),
  ask: (question) => ipcRenderer.invoke('voiceos:ask', question),
  cancel: () => ipcRenderer.invoke('voiceos:cancel'),

  // --- the microphone, which used to belong to the island ---
  submitAudio: ({ pcm, sampleRate, mode }) =>
    ipcRenderer.invoke('voiceos:submit-audio', { pcm, sampleRate, mode }),
  wakeAudio: (payload) => ipcRenderer.send('voiceos:wake-audio', payload),
  reportLevel: (level) => ipcRenderer.send('voiceos:level', level),
  speechStatus: (v) => ipcRenderer.send('voiceos:speech-status', v),

  // --- doing ---
  startMode: (mode) => ipcRenderer.send('voiceos:start-mode', mode),
  startFollowUp: () => ipcRenderer.send('voiceos:start-follow-up'),
  nothingHeard: () => ipcRenderer.send('voiceos:nothing-heard'),
  bargeIn: () => ipcRenderer.send('voiceos:barge-in'),
  openSettings: () => ipcRenderer.invoke('voiceos:open-settings'),
  setConfig: (key, value) => ipcRenderer.invoke('voiceos:set-config-value', { key, value }),

  // --- window chrome, since the frame is ours ---
  minimize: () => ipcRenderer.send('voiceos:console-minimize'),
  maximize: () => ipcRenderer.send('voiceos:console-maximize'),
  close: () => ipcRenderer.send('voiceos:console-close'),

  // --- watching ---
  onSessionStart: (fn) => on('session-start', fn),
  onSessionStop: (fn) => on('session-stop', fn),
  onSessionIdle: (fn) => on('session-idle', fn),
  onSessionCancel: (fn) => on('session-cancel', fn),
  onSessionStage: (fn) => on('session-stage', fn),
  onSessionError: (fn) => on('session-error', fn),
  onSessionApp: (fn) => on('session-app', fn),
  onTranscript: (fn) => on('transcript', fn),
  onAgentPartial: (fn) => on('agent-partial', fn),
  onAgentResult: (fn) => on('agent-result', fn),
  onSessionResult: (fn) => on('session-result', fn),
  onWakeState: (fn) => on('wake-state', fn),
  onSpeak: (fn) => on('speak', fn),
  onSecurityWarning: (fn) => on('security-warning', fn),
  onSettingsChanged: (fn) => on('settings-changed', fn),
  onVitals: (fn) => on('console-vitals', fn),
  // Approval for anything that sends, buys, books or changes something.
  onConfirm: (fn) => on('agent-confirm', fn),
  resolveConfirm: (id, approved) => ipcRenderer.invoke('voiceos:resolve-confirm', { id, approved })
});
