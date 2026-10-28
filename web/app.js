import { createSpeechPlayer } from './speech-playback.js';
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { createSingularity } from './singularity.js';
import { playStartup } from './startup.js';

const $ = (selector) => document.querySelector(selector);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const settings = { motion: true, interaction: true, speech: true };
const app = $('.orbit-app');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
let energy = 0;
let speechLevel = 0, taskProgress = 1;
let voicePreview = false;
let assistantState = 'idle';
let settleTimer;
let toastTimer;
let attachedFiles = [];
let activePopover = null;
let panelInvoker = null;
let activePage = 'home';
let pageExpanded = false;
let conversationQuery = '';
let fileQuery = '';
let selectedConversation = 'Make me a summary of my research notes.';
const overlays = [];
const mobileQuery = matchMedia('(max-width: 900px)');
const compactInputQuery = matchMedia('(max-width: 550px)');
let tasksOpen = !mobileQuery.matches;
const conversations = [];
let savedFiles = [];
let runtime = null;
let currentChatId = null;
let requesting = false;
let recorder, microphone, recordingTimer, recordingChunks = [], recordingCancelled = false, microphonePending = false;
const scene = createSingularity($('#singularity'), {
  getEnergy: () => energy,
  getSpeechLevel: () => speechLevel,
  getProgress: () => taskProgress,
  getMotion: () => settings.motion && !reducedMotion.matches,
  getInteraction: () => settings.interaction && !pageExpanded,
  getState: () => assistantState,
  onLight: (strength,position) => {
    app.style.setProperty('--scene-reflection', strength.toFixed(3));
    app.style.setProperty('--scene-light-position', `${position.toFixed(1)}%`);
  },
});

function setAssistantState(state) {
  clearTimeout(settleTimer);
  assistantState = state;
  app.dataset.state = state;
  if (state === 'complete') settleTimer = setTimeout(() => setAssistantState('idle'), 2100);
}

function syncVisualPreferences() {
  app.dataset.motion = String(settings.motion && !reducedMotion.matches);
  if (!settings.motion || reducedMotion.matches) {
    app.querySelectorAll('.is-arriving, .is-revealed, .is-sending, .just-completed').forEach(node => {
      node.classList.remove('is-arriving', 'is-revealed', 'is-sending', 'just-completed');
    });
    clearSurfaceLight();
  }
}

function animateSurface(node, className) {
  node.classList.remove(className);
  if (!settings.motion || reducedMotion.matches) return;
  void node.offsetWidth;
  node.classList.add(className);
}

for (const node of [$('.request-island'), $('.response-island'), $('#composer'), $('#task-panel'), ...document.querySelectorAll('.task-row')]) {
  node.addEventListener('animationend', event => {
    if (event.target === node) node.classList.remove('is-arriving', 'is-revealed', 'is-sending', 'just-completed');
  });
}

// Light follows the cursor only within a glass surface, without moving its content.
let lightFrame = 0;
let lightSurface = null;
let lightPosition = null;
function clearSurfaceLight() {
  lightSurface?.classList.remove('is-lit');
  lightSurface = null;
  lightPosition = null;
  cancelAnimationFrame(lightFrame);
  lightFrame = 0;
}
function onSurfacePointer(event) {
  if (!finePointer.matches || !settings.motion || reducedMotion.matches || pageExpanded) return clearSurfaceLight();
  const surface = event.target.closest('.request-island, .response-island, .composer, .task-panel');
  if (surface !== lightSurface) {
    clearSurfaceLight();
    lightSurface = surface;
  }
  if (!surface) return;
  lightPosition = { x: event.clientX, y: event.clientY };
  if (lightFrame) return;
  lightFrame = requestAnimationFrame(() => {
    lightFrame = 0;
    if (!lightSurface || !lightPosition) return;
    const rect = lightSurface.getBoundingClientRect();
    lightSurface.style.setProperty('--light-x', `${((lightPosition.x - rect.left) / rect.width * 100).toFixed(1)}%`);
    lightSurface.style.setProperty('--light-y', `${((lightPosition.y - rect.top) / rect.height * 100).toFixed(1)}%`);
    lightSurface.classList.add('is-lit');
  });
}
document.addEventListener('pointermove', onSurfacePointer, { passive: true });
document.addEventListener('pointerleave', clearSurfaceLight);
window.addEventListener('blur', clearSurfaceLight);
setAssistantState('idle');
syncVisualPreferences();

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3200);
}

function rememberOverlay(name) {
  forgetOverlay(name);
  overlays.push(name);
}

function forgetOverlay(name) {
  const index = overlays.indexOf(name);
  if (index !== -1) overlays.splice(index, 1);
}

function popoverTrigger(name) {
  return $(name === 'attach' ? '#attach-button' : '#response-more');
}

function closePopovers({ restoreFocus = false } = {}) {
  const trigger = activePopover ? popoverTrigger(activePopover) : null;
  for (const id of ['attach', 'response']) {
    $(`#${id}-menu`).hidden = true;
    popoverTrigger(id).setAttribute('aria-expanded', 'false');
  }
  activePopover = null;
  forgetOverlay('popover');
  if (restoreFocus && trigger) trigger.focus({ preventScroll: true });
}

function togglePopover(name) {
  const menu = $(`#${name}-menu`);
  const shouldOpen = menu.hidden;
  closePopovers();
  menu.hidden = !shouldOpen;
  popoverTrigger(name).setAttribute('aria-expanded', String(shouldOpen));
  if (shouldOpen) {
    activePopover = name;
    rememberOverlay('popover');
    menu.querySelector('button').focus({ preventScroll: true });
  }
}

function updateInputPlaceholder() {
  $('#message-input').placeholder = voicePreview ? 'Listening... tap the mic to stop' :
    compactInputQuery.matches ? 'Ask me anything...' : 'Type a message or ask me anything...';
}

updateInputPlaceholder();
compactInputQuery.addEventListener('change', updateInputPlaceholder);

async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw Error(data.error || `Request failed (${response.status}).`); }
  return response;
}
const post = async (url, data) => (await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json();

const meter = element('div', 'voice-meter');
meter.setAttribute('aria-hidden','true');
for(let i=0;i<5;i++)meter.append(element('span'));
$('#request-method').append(meter);
const player = createSpeechPlayer({
  request: text => api('/api/speech', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})}),
  onLevel: (level,bands) => {
    speechLevel=level; app.style.setProperty('--speech-level',level.toFixed(3));
    meter.querySelectorAll('span').forEach((bar,i)=>bar.style.height=`${3+bands[i]*23}px`);
  },
  onState: state => {
    $('#request-method').classList.toggle('is-speaking',state==='speaking');
    if(state==='preparing') $('#request-status').textContent='Preparing Kokoro voice…';
    if(state==='speaking'){energy=0;setAssistantState('speaking');$('#request-status').textContent='Speaking…';}
    if(['complete','stopped'].includes(state)&&!requesting&&!voicePreview){energy=0;if(assistantState==='speaking')setAssistantState('idle');$('#request-status').textContent='Ready when you are.';}
  }
});
function stopSpeech() { player.stop(); }
async function speak(text) {
  if(!runtime?.setup.speech)return;
  try {await player.speak(text);}catch(error){toast(`Voice: ${error.message} Use Read aloud to retry.`);}
}
function setProgress(value) {
  taskProgress=Math.max(taskProgress,Math.min(1,value));
  $('#status-ring').style.setProperty('--task-progress',`${taskProgress*360}deg`);
  $('#status-ring').setAttribute('aria-label',taskProgress===1?'Complete':'Processing; exact completion time unknown');
}
async function setVoice(active, { cancel = false } = {}) {
  if (!active) { recordingCancelled = cancel; if (recorder?.state === 'recording') recorder.stop(); return; }
  if (voicePreview || microphonePending) return;
  if (requesting) { toast('Wait for the current response.'); return; }
  if (!runtime?.setup.hasKey) { openPanel('settings'); toast('Add your Groq Free-plan key first.'); return; }
  stopSpeech(); player.unlock().catch(()=>{});
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw Error('Microphone recording is unavailable in this browser.');
    microphonePending = true; $('#mic-button').disabled = true;
    microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingCancelled = false;
    const mime = ['audio/webm;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(microphone, mime ? { mimeType: mime } : {});
    recordingChunks = []; recorder.ondataavailable = e => { if (e.data.size) recordingChunks.push(e.data); };
    recorder.onstop = async () => {
      clearTimeout(recordingTimer); microphone.getTracks().forEach(track => track.stop());
      voicePreview = false; energy = 0; $('#mic-button').setAttribute('aria-pressed', 'false'); $('#mic-button').setAttribute('aria-label', 'Record a voice message'); updateInputPlaceholder();
      if (recordingCancelled) { setAssistantState('idle'); $('#request-status').textContent = 'Recording cancelled.'; return; }
      $('#mic-button').disabled = true; $('#composer .send-button').disabled = true;
      setAssistantState('thinking'); $('#request-status').textContent = 'Transcribing your voice…';
      try {
        const blob = new Blob(recordingChunks, { type: recorder.mimeType });
        if (blob.size < 1000) throw Error('Recording was too short. Please try again.');
        const response = await api('/api/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
        const { text } = await response.json();
        if (!text?.trim()) throw Error('No speech detected.');
        $('#mic-button').disabled = false; $('#composer .send-button').disabled = false;
        await sendPrompt(text, 'voice');
      } catch (error) { setAssistantState('idle'); $('#request-status').textContent = 'Voice input failed.'; toast(error.message); }
      finally { $('#mic-button').disabled = false; $('#composer .send-button').disabled = false; }
    };
    recorder.start(); voicePreview = true; energy = .55; setAssistantState('listening');
    $('#mic-button').setAttribute('aria-pressed', 'true'); $('#mic-button').setAttribute('aria-label', 'Stop recording and send');
    $('#request-method use').setAttribute('href', '#i-wave'); $('#request-status').textContent = 'Listening · tap the microphone to send'; updateInputPlaceholder();
    recordingTimer = setTimeout(() => setVoice(false), 90000);
  } catch (error) { microphone?.getTracks().forEach(track => track.stop()); toast(error.message); }
  finally { microphonePending = false; $('#mic-button').disabled = false; }
}

async function sendPrompt(text, method = 'text') {
  if (voicePreview) { toast('Stop the microphone before sending a text message.'); return; }
  if (requesting) { toast('Jarvis is already handling a request.'); return; }
  if (!runtime?.setup.hasKey) { openPanel('settings'); toast('Add your Groq Free-plan key first.'); return; }
  stopSpeech(); closePopovers(); requesting = true;
  $('#composer .send-button').disabled = false;$('#composer .send-button').setAttribute('aria-label','Stop request');$('#composer .send-button use').setAttribute('href','#i-stop');
  taskProgress=0;setProgress(.08);
  setAssistantState('thinking'); scene.cue?.('submit'); energy = .8;
  animateSurface($('.request-island'), 'is-arriving'); animateSurface($('#composer'), 'is-sending');
  $('#current-request').textContent = text;
  $('#request-method use').setAttribute('href', method === 'voice' ? '#i-wave' : '#i-keyboard');
  $('#request-status').textContent = 'Thinking…'; $('#status-ring').classList.remove('ready');
  $('.response-island').classList.add('is-thinking'); $('#current-response').textContent = 'Thinking…';
  let answer, failed = false;
  try {
    const response = await api('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, method, chatId: currentChatId, attachments: attachedFiles.map(f => f.id) }) });
    $('#message-input').value = ''; attachedFiles = []; updateAttachmentChip();
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
    for (;;) {
      const { done, value } = await reader.read(); pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) if (line.trim()) {
        const event = JSON.parse(line);
        if (event.type === 'chat') currentChatId = event.id;
        if (typeof event.progress === 'number') setProgress(event.progress);
        if (event.type === 'status') { $('#request-status').textContent = event.text; $('#current-response').textContent = event.text; setAssistantState('thinking'); }
        if (event.type === 'answer') { setProgress(1); answer = event.text; renderAnswer($('#current-response'), answer); }
        if (event.type === 'error') { failed = true; $('#current-response').textContent = event.text; toast(event.text); }
      }
      if (done) break;
    }
    if (!answer && !failed) throw Error('The response connection ended before completion. Check Tasks before retrying.');
  } catch (error) { failed = true; $('#current-response').textContent = error.message; toast(error.message); }
  finally {
    setProgress(1); requesting = false; $('#composer .send-button').disabled = false;$('#composer .send-button').setAttribute('aria-label','Send message');$('#composer .send-button use').setAttribute('href','#i-send'); energy = 0;
    $('.response-island').classList.remove('is-thinking'); $('#status-ring').classList.add('ready');
    $('#request-status').textContent = failed ? 'Request failed.' : 'Your request is complete.';
    setAssistantState(failed ? 'idle' : 'complete');
    if (!failed) { scene.cue?.('complete'); animateSurface($('.response-island'), 'is-revealed'); }
    await refreshRuntime();
    if (answer) { $('#live-status').textContent = answer; void speak(answer); }
  }
}

$('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  if(requesting){void post('/api/chat/cancel',{}).then(()=>{$('#request-status').textContent='Stopping the current request…';}).catch(error=>toast(error.message));return;}
  player.unlock().catch(()=>{});
  const text = $('#message-input').value.trim();
  if (!text) {
    $('#message-input').focus();
    toast('Add a thought to send it to Jarvis.');
    return;
  }
  sendPrompt(text);
  if (requesting) $('#message-input').value = '';
});
$('#mic-button').addEventListener('click', () => setVoice(!voicePreview));
$('#attach-button').addEventListener('click', () => togglePopover('attach'));
$('#response-more').addEventListener('click', () => togglePopover('response'));
$('#choose-files').addEventListener('click', () => { closePopovers({ restoreFocus: true }); $('#file-input').click(); });
$('#use-example').addEventListener('click', () => {
  closePopovers();
  $('#message-input').value = 'Help me plan a thoughtful week.';
  $('#message-input').focus();
});
$('#file-input').addEventListener('change', async (event) => {
  const added = Array.from(event.target.files); event.target.value = '';
  for (const file of added) {
    try {
      toast(`Adding ${file.name}…`);
      const response = await api('/api/files', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
      const saved = await response.json(); attachedFiles.push(saved); selectedWorkspaceFile = saved.id;
      toast(saved.capability === 'Stored only' || saved.capability === 'Image preview' ? saved.note : `${file.name} · ${saved.capability}`);
    } catch (error) { toast(error.message); }
  }
  updateAttachmentChip(); await refreshRuntime();
  if (activePage === 'workspace') openPanel('workspace');
});
$('#remove-attachment').addEventListener('click', () => {
  attachedFiles = []; updateAttachmentChip(); $('#attach-button').focus({ preventScroll: true });
});
$('#copy-response').addEventListener('click', async () => {
  closePopovers({ restoreFocus: true });
  try {
    await navigator.clipboard.writeText($('#current-response').textContent);
    toast('Response copied.');
  } catch { toast('Copy is unavailable in this browser.'); }
});
$('#stop-speech').addEventListener('click', () => { closePopovers(); stopSpeech(); });
$('#replay-response').addEventListener('click', () => { closePopovers({ restoreFocus: true }); void speak($('#current-response').textContent); });
function setTasks(open, { restoreFocus = false } = {}) {
  const mobile = mobileQuery.matches;
  const panel = $('#task-panel');
  const toggle = $('#restore-tasks');
  tasksOpen = open;
  panel.classList.toggle('is-closed', !open);
  panel.classList.toggle('mobile-open', mobile && open);
  panel.inert = pageExpanded || !open;
  panel.setAttribute('aria-hidden', String(pageExpanded || !open));
  toggle.hidden = !mobile && open;
  toggle.classList.toggle('visible', !open && !mobile);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', mobile && open ? 'Close tasks' : 'Open tasks');
  if (mobile && open) rememberOverlay('tasks');
  else forgetOverlay('tasks');
  if (restoreFocus && !open) toggle.focus({ preventScroll: true });
}
$('#close-tasks').addEventListener('click', () => setTasks(false, { restoreFocus: true }));
$('#restore-tasks').addEventListener('click', () => {
  setTasks(!tasksOpen);
  if (tasksOpen) $('#close-tasks').focus({ preventScroll: true });
});
setTasks(tasksOpen);
mobileQuery.addEventListener('change', (event) => {
  const panelHadFocus = $('#task-panel').contains(document.activeElement);
  const toggleHadFocus = document.activeElement === $('#restore-tasks');
  setTasks(!event.matches, { restoreFocus: event.matches && panelHadFocus });
  if (!event.matches && toggleHadFocus) $('#close-tasks').focus({ preventScroll: true });
});
function icon(symbol, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${symbol}`);
  svg.append(use);
  return svg;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(text, symbol, className, action) {
  const button = element('button', className);
  button.type = 'button';
  if (symbol) button.append(icon(symbol));
  button.append(element('span', '', text));
  button.addEventListener('click', action);
  return button;
}

function syncExpandedPage() {
  clearSurfaceLight();
  $('.orbit-app').classList.toggle('is-page-open', pageExpanded);
  $('#side-panel').classList.toggle('is-expanded', pageExpanded);
  for (const selector of ['.request-island', '.response-island', '#composer', '.orbit-wordmark', '#singularity']) {
    const node = $(selector);
    node.inert = pageExpanded;
    node.setAttribute('aria-hidden', String(pageExpanded));
  }
  $('#task-panel').inert = pageExpanded || !tasksOpen;
  $('#task-panel').setAttribute('aria-hidden', String(pageExpanded || !tasksOpen));
  $('#restore-tasks').inert = pageExpanded;
  $('#restore-tasks').setAttribute('aria-hidden', String(pageExpanded));
  const nav = $('.navigation');
  const navHadFocus = nav.contains(document.activeElement);
  nav.inert = pageExpanded && compactInputQuery.matches;
  nav.setAttribute('aria-hidden', String(pageExpanded && compactInputQuery.matches));
  if (nav.inert && navHadFocus) $('#panel-expand')?.focus({ preventScroll: true });
}
compactInputQuery.addEventListener('change', syncExpandedPage);

function setPanelExpanded(expanded) {
  closePopovers();
  openPanel(activePage, { expanded });
  $('#panel-expand').focus({ preventScroll: true });
}

function panelHeader(title) {
  const header = element('header', 'panel-header');
  const heading = element('div', 'panel-heading');
  if (pageExpanded) heading.append(element('span', 'panel-eyebrow', 'J.A.R.V.I.S. / YOUR SPACE'));
  const titleNode = element('h2', '', title);
  titleNode.id = 'panel-title';
  heading.append(titleNode);
  const actions = element('div', 'panel-header-actions');
  const expand = actionButton(pageExpanded ? 'Quick view' : 'Expand', pageExpanded ? 'collapse' : 'expand', 'plain-button expand-button', () => setPanelExpanded(!pageExpanded));
  expand.id = 'panel-expand';
  expand.setAttribute('aria-label', `${pageExpanded ? 'Collapse' : 'Expand'} ${title.toLowerCase()}`);
  expand.setAttribute('aria-expanded', String(pageExpanded));
  expand.setAttribute('aria-controls', 'panel-body');
  expand.title = pageExpanded ? 'Return to quick view' : 'Open full page';
  const close = actionButton('Close', 'close', 'plain-button panel-close', () => openPanel('home', { restoreFocus: true }));
  close.setAttribute('aria-label', `Close ${title.toLowerCase()}`);
  actions.append(expand, close);
  header.append(heading, actions);
  return header;
}

function intro(title, description) {
  const section = element('div', 'page-intro');
  section.append(element('h3', '', title), element('p', '', description));
  return section;
}

function searchField(label, value, onInput) {
  const field = element('label', 'page-search');
  field.append(icon('search'));
  const input = element('input');
  input.type = 'search';
  input.placeholder = label;
  input.setAttribute('aria-label', label);
  input.value = value;
  input.addEventListener('input', () => onInput(input.value));
  field.append(input);
  return field;
}

function beginMessage(text = '', chatId = null) {
  currentChatId = chatId;
  if (!chatId) { stopSpeech(); $('#current-request').textContent = 'A new conversation'; $('#current-response').textContent = 'What would you like to explore?'; $('#request-status').textContent = 'Ready when you are.'; }
  openPanel('home');
  $('#message-input').value = text;
  $('#message-input').focus({ preventScroll: true });
}

function selectedConversationItem() {
  return conversations.find(item => item.id === selectedConversation) || conversations[0];
}

function renderConversationDetail() {
  const detail = $('.conversation-detail'); if (!detail) return;
  const item = selectedConversationItem(); detail.replaceChildren();
  if (!item) { detail.append(element('p', 'page-empty', 'Your conversations will appear here.')); return; }
  const header = element('div', 'detail-header'); header.append(element('small', '', `${item.time} · Conversation`), element('h3', '', item.title));
  const thread = element('div', 'detail-thread');
  for (const message of item.messages) {
    const row = element('div', `thread-message ${message.role === 'user' ? 'is-user' : 'is-assistant'}`);
    const content = element('div', 'thread-content');
    if (message.role === 'assistant') renderAnswer(content, message.content);
    else content.append(element('p', '', message.content));
    row.append(element('span', 'message-label', message.role === 'user' ? `YOU · ${message.method || 'text'}` : 'J.A.R.V.I.S.'), content);
    thread.append(row);
  }
  const footer = element('div', 'detail-footer');
  footer.append(actionButton('Continue conversation', 'arrow', 'page-secondary', () => { restoreChat(item); beginMessage('', item.id); }), actionButton('Delete conversation', null, 'file-remove', async () => {
    try { await api(`/api/chats/${item.id}`, { method: 'DELETE' }); if (currentChatId === item.id) currentChatId = null; selectedConversation = null; await refreshRuntime(); openPanel('conversations'); } catch (error) { toast(error.message); }
  }));
  detail.append(header, thread, footer);
}
function restoreChat(item) {
  currentChatId = item.id; selectedConversation = item.id;
  const lastUser = item.messages.findLast(m => m.role === 'user'), lastAnswer = item.messages.findLast(m => m.role === 'assistant');
  $('#current-request').textContent = lastUser?.content || 'A new conversation'; renderAnswer($('#current-response'), lastAnswer?.content || 'What would you like to explore?');
  $('#request-method use').setAttribute('href', lastUser?.method === 'voice' ? '#i-wave' : '#i-keyboard'); $('#request-status').textContent = 'Conversation restored.';
}

function renderConversationCards() {
  const list = $('.conversation-list');
  if (!list) return;
  list.replaceChildren();
  const query = conversationQuery.trim().toLowerCase();
  const matches = conversations.filter(item => `${item.title} ${item.prompt}`.toLowerCase().includes(query));
  if (!matches.length) {
    list.append(element('div', 'page-empty', 'No conversations found. Try another search.'));
    return;
  }
  matches.forEach(item => {
    const button = element('button', 'conversation-card');
    button.type = 'button';
    button.dataset.prompt = item.id;
    button.classList.toggle('active', selectedConversationItem()?.id === item.id);
    button.setAttribute('aria-pressed', String(selectedConversationItem()?.id === item.id));
    const mark = element('span', 'conversation-icon');
    mark.append(icon('chat'));
    const copy = element('span', 'conversation-copy');
    copy.append(element('strong', '', item.title), element('p', '', item.prompt), element('small', '', item.time));
    button.append(mark, copy, icon('arrow', 'icon conversation-arrow'));
    button.addEventListener('click', () => {
      selectedConversation = item.id;
      list.querySelectorAll('.conversation-card').forEach(card => {
        const selected = card.dataset.prompt === selectedConversation;
        card.classList.toggle('active', selected);
        card.setAttribute('aria-pressed', String(selected));
      });
      renderConversationDetail();
    });
    list.append(button);
  });
}

function renderConversations(body) {
  if (!pageExpanded) {
    body.append(actionButton('New conversation', 'plus', 'panel-action', () => beginMessage()));
    if (!conversations.length) body.append(element('p', 'panel-caption', 'Your saved conversations will appear here.'));
    conversations.forEach(item => {
      const button = element('button', 'conversation-item');
      const copy = element('span');
      copy.append(element('strong', '', item.title), element('small', '', item.time));
      button.append(icon('chat'), copy);
      button.addEventListener('click', () => { restoreChat(item); openPanel('home', { restoreFocus: true }); });
      body.append(button);
    });
    return;
  }
  body.append(intro('Pick up a thought.', 'A little room for the things you’re exploring.'));
  const toolbar = element('div', 'page-toolbar');
  toolbar.append(searchField('Search conversations', conversationQuery, value => { conversationQuery = value; renderConversationCards(); }),
    actionButton('New conversation', 'plus', 'page-primary', () => beginMessage()));
  const layout = element('div', 'conversation-layout');
  const index = element('section', 'conversation-index');
  index.setAttribute('aria-label', 'Conversation list');
  index.append(element('div', 'conversation-list'));
  const detail = element('section', 'conversation-detail');
  detail.setAttribute('aria-label', 'Selected conversation');
  detail.setAttribute('aria-live', 'polite');
  layout.append(index, detail);
  body.append(toolbar, layout);
  renderConversationCards();
  renderConversationDetail();
}

let selectedWorkspaceFile = null;
let previewSequence = 0;
function workspaceFiles() {
  return savedFiles.map(file => ({ ...file, title: file.name, type: file.name.split('.').pop().toUpperCase().slice(0,5), label: `${(file.size / 1024).toFixed(1)} KB · ${file.capability}` }));
}

function updateAttachmentChip() {
  $('#attachment-chip').hidden = !attachedFiles.length;
  $('#attachment-name').textContent = attachedFiles.length === 1 ? attachedFiles[0].name : `${attachedFiles.length} files attached`;
}

async function renderFilePreview() {
  const detail = $('.workspace-detail'); if (!detail) return;
  const item = workspaceFiles().find(f => f.id === selectedWorkspaceFile) || workspaceFiles()[0];
  detail.replaceChildren(); if (!item) { detail.append(element('p', 'page-empty', 'Add a file to see it here.')); return; }
  selectedWorkspaceFile = item.id; const sequence = ++previewSequence;
  const preview = element('div', 'file-preview'); preview.append(element('small', '', item.label), element('h3', '', item.name), element('p', 'workspace-note', item.note));
  detail.append(preview);
  if (/^image\/(png|jpeg|webp|gif)$/.test(savedFiles.find(f => f.id === item.id)?.type || '')) {
    const image = element('img', 'workspace-image'); image.src = `/api/files/${item.id}?preview`; image.alt = item.name; preview.append(image);
  }
  if (item.characters) {
    const text = element('pre', 'file-preview-text', 'Opening…'); preview.append(text);
    try { const data = await (await api(`/api/files/${item.id}/text`)).json(); if (sequence === previewSequence && text.isConnected) text.textContent = data.text.slice(0,16000); }
    catch (error) { text.textContent = error.message; }
  }
  const footer = element('div', 'detail-footer');
  footer.append(actionButton('Use in a message', 'arrow', 'page-secondary', () => { if (!attachedFiles.some(f => f.id === item.id)) attachedFiles.push(item); updateAttachmentChip(); beginMessage(`Help me review ${item.name}.`); }), actionButton('Download', 'arrow', 'page-secondary', () => { const a = element('a'); a.href = `/api/files/${item.id}`; a.download = item.name; a.click(); }), actionButton('Remove file', null, 'file-remove', async () => {
    try { await api(`/api/files/${item.id}`, { method: 'DELETE' }); attachedFiles = attachedFiles.filter(f => f.id !== item.id); updateAttachmentChip(); await refreshRuntime(); renderFileCards(); renderFilePreview(); } catch (error) { toast(error.message); }
  }));
  detail.append(footer);
}

function renderFileCards() {
  const grid = $('.file-grid');
  if (!grid) return;
  grid.replaceChildren();
  const query = fileQuery.trim().toLowerCase();
  const matches = workspaceFiles().filter(file => `${file.name} ${file.type}`.toLowerCase().includes(query));
  if (!matches.length) {
    grid.append(element('div', 'page-empty', 'No files found. Try another search or add a file.'));
    return;
  }
  matches.forEach(file => {
    const card = element('button', 'file-card');
    card.type = 'button';
    card.dataset.file = file.id;
    card.classList.toggle('active', file.id === selectedWorkspaceFile);
    card.setAttribute('aria-pressed', String(file.id === selectedWorkspaceFile));
    const mark = element('span', 'file-icon');
    mark.append(icon('file'));
    const copy = element('span', 'file-info');
    copy.append(element('strong', '', file.name), element('small', '', file.label));
    card.append(mark, copy, element('span', 'file-badge', file.type));
    card.addEventListener('click', () => {
      selectedWorkspaceFile = file.id;
      grid.querySelectorAll('.file-card').forEach(button => {
        const selected = button.dataset.file === file.id;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      renderFilePreview();
    });
    grid.append(card);
  });
}

function renderWorkspace(body) {
  const addFiles = actionButton('Add files', 'plus', pageExpanded ? 'page-primary' : 'panel-action', () => $('#file-input').click());
  addFiles.id = 'workspace-add-files';
  if (!pageExpanded) {
    body.append(element('p', 'panel-caption', 'A little space for the things you’re working on.'));
    if (!workspaceFiles().length) body.append(element('p', 'workspace-note', 'Only files you add will appear here.'));
    workspaceFiles().forEach(file => {
      const row = element('button', 'workspace-file');
      row.type = 'button'; row.addEventListener('click', () => { selectedWorkspaceFile = file.id; openPanel('workspace', { expanded: true }); });
      row.append(icon('file'), element('span', '', file.name));
      body.append(row);
    });
    body.append(addFiles);
    return;
  }
  body.append(intro('Room for your ideas.', 'Notes, outlines, and the things that make a thought clearer.'));
  const toolbar = element('div', 'page-toolbar');
  toolbar.append(searchField('Search files', fileQuery, value => { fileQuery = value; renderFileCards(); }),
    addFiles);
  const layout = element('div', 'workspace-layout');
  layout.append(element('section', 'file-grid'), element('section', 'workspace-detail'));
  layout.firstChild.setAttribute('aria-label', 'Workspace files');
  layout.lastChild.setAttribute('aria-label', 'Selected file preview');
  body.append(toolbar, layout, element('p', 'workspace-note', 'Files are saved on this device. Selected text and audio are sent to Groq for interpretation.'));
  renderFileCards();
  renderFilePreview();
}

function settingControl(setting) {
  const row = element('div', 'setting-row');
  const copy = element('span', '', setting.label);
  copy.append(element('small', '', setting.description));
  const button = element('button', 'switch');
  button.type = 'button';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-label', setting.label);
  const systemPaused = setting.key === 'motion' && reducedMotion.matches;
  button.setAttribute('aria-checked', String(settings[setting.key] && !systemPaused));
  button.disabled = systemPaused;
  if (systemPaused) copy.querySelector('small').textContent = 'Paused by your device’s reduced-motion setting';
  button.addEventListener('click', () => {
    settings[setting.key] = !settings[setting.key];
    syncVisualPreferences();
    button.setAttribute('aria-checked', String(settings[setting.key]));
    updateSettingsPreview();
  });
  row.append(copy, button);
  return row;
}

function updateSettingsPreview() {
  const motionEnabled = settings.motion && !reducedMotion.matches;
  const motionControl = $('.setting-row .switch[aria-label="Ambient motion"]');
  if (motionControl) {
    motionControl.disabled = reducedMotion.matches;
    motionControl.setAttribute('aria-checked', String(motionEnabled));
    motionControl.closest('.setting-row').querySelector('small').textContent = reducedMotion.matches
      ? 'Paused by your device’s reduced-motion setting' : 'Let the singularity drift';
  }
  const preview = $('.settings-preview');
  if (!preview) return;
  preview.dataset.motion = String(motionEnabled);
  preview.querySelector('.preview-motion-status').textContent = reducedMotion.matches
    ? 'Ambient motion is paused by your device' : motionEnabled ? 'Ambient motion is on' : 'Ambient motion is paused';
  preview.querySelector('.preview-interaction-status').textContent = settings.interaction ? 'Cursor gravity is on' : 'Cursor gravity is off';
}

function renderSettings(body) {
  body.append(renderAssistantSettings());
  const controls = [
    { key: 'motion', label: 'Ambient motion', description: 'Let the singularity drift' },
    { key: 'interaction', label: 'Cursor gravity', description: 'Bend the space around you' },
  ];
  if (!pageExpanded) {
    body.append(element('p', 'panel-caption', 'Make this space feel like yours.'));
    controls.forEach(setting => body.append(settingControl(setting)));
    const hint = element('p', 'keyboard-hint');
    hint.append(document.createTextNode('Press '), element('kbd', '', '/'), document.createTextNode(' to start a thought.'));
    body.append(hint);
    return;
  }
  body.append(intro('Make space feel like you.', 'A few thoughtful controls for a calmer Jarvis.'));
  const layout = element('div', 'settings-layout');
  const column = element('div', 'settings-controls');
  const motion = element('section', 'settings-card');
  motion.append(element('h3', '', 'Singularity'), element('p', '', 'Choose how your space moves and responds.'));
  controls.forEach(setting => motion.append(settingControl(setting)));
  const shortcuts = element('section', 'settings-card settings-shortcuts');
  shortcuts.append(element('h3', '', 'A little quicker'), element('p', '', 'Keep your hands on a thought.'));
  for (const [key, label] of [['/', 'Start a message'], ['Esc', 'Return to quick view'], ['Tab', 'Move between controls']]) {
    const row = element('div', 'shortcut-row');
    row.append(element('span', '', label), element('kbd', '', key));
    shortcuts.append(row);
  }
  column.append(motion, shortcuts);
  const preview = element('section', 'settings-preview');
  preview.setAttribute('aria-label', 'Singularity preferences preview');
  const orbital = element('div', 'preview-orbit');
  orbital.setAttribute('aria-hidden', 'true');
  orbital.append(element('span'), element('span'), element('span'));
  preview.append(element('small', 'panel-eyebrow', 'YOUR J.A.R.V.I.S.'), orbital, element('h3', '', 'A quiet kind of energy.'), element('p', 'preview-motion-status'), element('p', 'preview-interaction-status'));
  layout.append(column, preview);
  body.append(layout);
  updateSettingsPreview();
}

function openPanel(name, { restoreFocus = false, expanded = pageExpanded } = {}) {
  const panel = $('#side-panel');
  const invoker = panelInvoker;
  activePage = name;
  pageExpanded = name !== 'home' && expanded;
  document.querySelectorAll('.nav-button').forEach(button => {
    const active = button.dataset.panel === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    if (button.dataset.panel !== 'home') button.setAttribute('aria-expanded', String(active));
  });
  panel.replaceChildren();
  panel.hidden = name === 'home';
  panel.dataset.page = name;
  if (name === 'home') {
    forgetOverlay('panel');
    panelInvoker = null;
    syncExpandedPage();
    if (restoreFocus && invoker) invoker.focus({ preventScroll: true });
    return;
  }
  panelInvoker = $(`.nav-button[data-panel="${name}"]`);
  rememberOverlay('panel');
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  panel.setAttribute('aria-label', title);
  panel.setAttribute('aria-labelledby', 'panel-title');
  panel.append(panelHeader(title));
  const body = element('div', 'panel-body');
  body.id = 'panel-body';
  panel.append(body);
  if (name === 'conversations') renderConversations(body);
  if (name === 'workspace') renderWorkspace(body);
  if (name === 'settings') renderSettings(body);
  syncExpandedPage();
}

document.querySelectorAll('.nav-button').forEach((button) => {
  button.addEventListener('click', () => {
    closePopovers();
    const isOpen = button.classList.contains('active');
    openPanel(isOpen ? 'home' : button.dataset.panel);
  });
});
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.popover, #attach-button, #response-more')) closePopovers();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const overlay = overlays.at(-1);
    if (overlay === 'popover') closePopovers({ restoreFocus: true });
    else if (overlay === 'panel') {
      if (pageExpanded) setPanelExpanded(false);
      else openPanel('home', { restoreFocus: true });
    }
    else if (overlay === 'tasks') setTasks(false, { restoreFocus: true });
    else if (voicePreview) setVoice(false, { cancel: true });
    else return;
    event.preventDefault();
    return;
  }
  if (event.key === '/' && !event.target.matches('input, textarea')) {
    event.preventDefault();
    if (pageExpanded) beginMessage();
    else $('#message-input').focus();
  }
});
reducedMotion.addEventListener('change', () => {
  syncVisualPreferences();
  updateSettingsPreview();
});
window.addEventListener('pagehide', (event) => {
  if (event.persisted) {
    clearSurfaceLight();
    return;
  }
  scene.destroy();
  clearTimeout(toastTimer);
  clearTimeout(settleTimer);
  clearSurfaceLight();
  document.removeEventListener('pointermove', onSurfacePointer);
  document.removeEventListener('pointerleave', clearSurfaceLight);
  window.removeEventListener('blur', clearSurfaceLight);
});

let runtimeRefresh;
async function refreshRuntime(initial = false) {
  if (runtimeRefresh) return runtimeRefresh;
  runtimeRefresh = (async () => {
    try {
      runtime = await (await api('/api/state')).json();
      settings.speech = runtime.setup.speech;
      document.querySelectorAll('.groq-usage').forEach(node=>node.replaceWith(renderGroqUsage()));
      savedFiles = runtime.files;
      conversations.splice(0, conversations.length, ...runtime.chats.map(chat => ({ ...chat, prompt: chat.messages.find(m => m.role === 'user')?.content || '', time: new Date(chat.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) })));
      renderTasks();
      if (activePage === 'conversations') { renderConversationCards(); renderConversationDetail(); }
      if (initial) {
        $('#current-request').textContent = 'What would you like to do?';
        $('#current-response').textContent = runtime.setup.hasKey ? 'I’m ready. Ask a question, open an app, or schedule a reminder.' : 'Connect your Groq Free-plan key in Settings to get started.';
        $('#request-status').textContent = runtime.setup.hasKey ? 'Ready when you are.' : 'Setup needed · open Settings';
        $('#status-ring').classList.add('ready');
        $('#mic-button').setAttribute('aria-label', 'Record a voice message');
        if (runtime.setup.hasKey && runtime.setup.speech) post('/api/speech/load', {}).catch(error => toast(`Kokoro: ${error.message}`));
      }
    } catch (error) {
      if (initial) { $('#current-request').textContent = 'Jarvis needs its local companion.'; $('#current-response').textContent = 'Start the local Jarvis server to use AI, files, chats, and computer actions.'; $('#request-status').textContent = error.message; }
    }
  })().finally(() => { runtimeRefresh = null; });
  return runtimeRefresh;
}
function renderTasks() {
  if (!runtime) return;
  const current = $('#task-panel .task-section:not(.upcoming) .task-list'), upcoming = $('#task-panel .upcoming .task-list');
  current.replaceChildren(); upcoming.replaceChildren();
  const scheduled = runtime.tasks.filter(t => t.status === 'scheduled').sort((a,b) => Date.parse(a.dueAt)-Date.parse(b.dueAt));
  const active = runtime.tasks.filter(t => t.status === 'running').reverse();
  const recent = runtime.tasks.filter(t => ['complete','failed'].includes(t.status)).slice(-3).reverse();
  function row(task, container) {
    const button = element('button', `task-row ${task.status === 'running' ? 'running' : ''} ${task.status === 'complete' ? 'is-complete' : ''}`);
    button.type = 'button'; const check = element('span', `task-check ${task.status === 'running' ? 'progress live-progress' : ''}`);
    const copy = element('span', 'task-copy');
    const when = task.dueAt ? new Date(task.dueAt).toLocaleString('en-US', { timeZone: 'America/New_York', month:'short',day:'numeric',hour:'numeric',minute:'2-digit' }) + ' ET' : task.detail;
    copy.append(element('span', 'task-title', task.title), element('span', 'task-description', task.status === 'scheduled' ? when : task.detail)); button.append(check, copy);
    button.title = task.status === 'scheduled' ? 'Click to view task options' : task.detail;
    button.addEventListener('click', () => {
      if (task.status !== 'scheduled') { toast(`${task.title} · ${task.detail}`); return; }
      const existing = button.nextElementSibling;
      if (existing?.classList.contains('task-actions')) { existing.remove(); return; }
      const actions = element('div', 'task-actions');
      for (const [label,status] of [['Complete','complete'],['Cancel','cancelled']]) actions.append(actionButton(label,null,'page-secondary',async()=> {
        try { await api(`/api/tasks/${task.id}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})}); await refreshRuntime(); } catch(error) { toast(error.message); }
      }));
      button.after(actions);
    });
    container.append(button);
  }
  [...active,...recent].forEach(t => row(t,current)); scheduled.forEach(t=>row(t,upcoming));
  if (!active.length && !recent.length) current.append(element('p','workspace-note','No active tasks.'));
  if (!scheduled.length) upcoming.append(element('p','workspace-note','Ask Jarvis to schedule something.'));
  if (!$('#clear-finished')) {
    const clear = actionButton('Clear finished', null, 'panel-action', async () => {
      try { for (const task of runtime.tasks.filter(t => ['complete','cancelled','failed'].includes(t.status))) await api(`/api/tasks/${task.id}`, { method:'DELETE' }); await refreshRuntime(); } catch(error) { toast(error.message); }
    }); clear.id='clear-finished'; $('#task-panel').append(clear);
  }
  $('#clear-finished').hidden = !runtime.tasks.some(t => ['complete','cancelled','failed'].includes(t.status));
  if (!$('#aadddd-reminder')) {
    const button = actionButton('Add reminder','plus','panel-action', () => {
      let form = $('#reminder-form'); if (form) { form.remove(); return; }
      form = element('form','assistant-form');form.id='reminder-form';
      const title=element('input');title.placeholder='Reminder';title.required=true;title.maxLength=200;title.setAttribute('aria-label','Reminder title');
      const due=element('input');due.type='datetime-local';due.required=true;due.setAttribute('aria-label','Reminder date and time');
      const submit=element('button','page-primary','Schedule');submit.type='submit';
      form.append(title,due,element('small','workspace-note','Use your device’s local time. Jarvis must be running.'),submit);
      form.addEventListener('submit',async e=>{e.preventDefault();try{await post('/api/tasks',{title:title.value,dueAt:new Date(due.value).toISOString(),action:'reminder',args:{}});form.remove();toast('Reminder scheduled.');await refreshRuntime();}catch(error){toast(error.message);}});
      button.after(form);title.focus();
    });button.id='add-reminder'; $('#task-panel').append(button);
  }
}
function renderAssistantSettings() {
  const card = element('section','settings-card assistant-settings');
  card.append(element('h3','','Assistant'),element('p','', 'Groq Free plan · GPT-OSS 120B. Keep your account on the Free plan; Jarvis stops at quota limits and has no paid fallback.'));
  const form=element('form','assistant-form');
  const label=element('label','',runtime?.setup.hasKey ? 'Replace Groq key' : 'Groq API key');
  const key=element('input');key.type='password';key.autocomplete='off';key.placeholder=runtime?.setup.hasKey ? 'Connected · enter a replacement key' : 'gsk_…';key.setAttribute('aria-label','Groq API key');label.append(key);
  const save=element('button','page-primary','Save key');save.type='submit';
  const message=element('small','workspace-note',runtime?.setup.hasKey?'Key stored privately on this device.':'Create a Free-plan key at console.groq.com/keys.');message.setAttribute('role','status');
  form.append(label,save,message);
  form.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;try{if(!key.value.trim())throw Error('Enter your new Groq key.');await post('/api/settings',{groqKey:key.value.trim()});key.value='';message.textContent='Key saved privately on this device.';await refreshRuntime();}catch(error){message.textContent=error.message;}finally{save.disabled=false;}});
  const connection = element('div', 'connection-settings'); connection.append(form); card.append(connection);
  const speechControls = element('div', 'speech-settings');
  const row=element('label','setting-row');row.append(element('span','','Read replies aloud · local Kokoro'));
  const toggle=element('input');toggle.type='checkbox';toggle.checked=runtime?.setup.speech??true;toggle.setAttribute('aria-label','Read replies aloud');
  toggle.addEventListener('change',async()=>{try{await post('/api/settings',{speech:toggle.checked});if(!toggle.checked)stopSpeech();await refreshRuntime();}catch(error){toast(error.message);}});row.append(toggle);speechControls.append(row);
  const voice=element('select');voice.setAttribute('aria-label','Kokoro voice');
  for(const [value,label] of [['af_heart','Heart · US'],['af_bella','Bella · US'],['am_adam','Adam · US'],['bf_emma','Emma · UK'],['bm_george','George · UK']]) { const option=element('option','',label);option.value=value;voice.append(option); }
  voice.value=runtime?.setup.voice||'af_heart';voice.addEventListener('change',async()=>{try{await post('/api/settings',{voice:voice.value});await refreshRuntime();}catch(error){toast(error.message);}});speechControls.append(voice);
  speechControls.append(actionButton('Test Kokoro voice','wave','page-secondary',()=>{ player.unlock().catch(()=>{}); void speak('Hello. I’m Jarvis, your personal assistant.'); }));
  speechControls.append(element('p','workspace-note',`Kokoro: ${runtime?.setup.kokoro||'not loaded'}. Speech is generated locally. Voice input and selected file text/transcripts go to Groq.`));
  card.append(speechControls);
  const appControls=element('section','app-control-settings');
  appControls.append(element('h3','','App control'),element('p','workspace-note','Read app controls, click buttons, enter text and use keyboard shortcuts. Visible app text is sent to Groq to carry out your request; password fields are excluded. Enable only when you want Jarvis to interact with your apps.'));
  const controlLabel=element('label','setting-row');controlLabel.append(element('span','','Allow app interaction'));
  const controlToggle=element('input');controlToggle.type='checkbox';controlToggle.checked=!!runtime?.setup.appControl;controlToggle.setAttribute('aria-label','Allow app interaction');
  const accessMessage=element('p','workspace-note',runtime?.setup.platform==='win32'?'Uses Windows UI Automation. Protected/elevated apps may be unavailable.':'Enable Jarvis in macOS System Settings → Privacy & Security → Device Control and Data Access (Accessibility on older macOS).');accessMessage.setAttribute('role','status');
  controlToggle.addEventListener('change',async()=>{try{await post('/api/settings',{appControl:controlToggle.checked});await refreshRuntime();const status=await(await api('/api/app-control/status')).json();accessMessage.textContent=controlToggle.checked?(status.available?'App control is ready. Ask Jarvis to use an app.':'App control is enabled, but macOS Device Control and Data Access permission is still needed for Jarvis.'):'App control disabled.';}catch(error){accessMessage.textContent=error.message;}});
  controlLabel.append(controlToggle);appControls.append(controlLabel,actionButton('Check app access',null,'page-secondary',async()=>{try{const status=await(await api('/api/app-control/status')).json();accessMessage.textContent=status.available?'System app access is available. Enable Allow app interaction to use it.':status.permission+' permission is needed. Enable Jarvis in System Settings, then check again.';}catch(error){accessMessage.textContent=error.message;}}),accessMessage);
  if(runtime?.setup.platform==='darwin'){appControls.append(element('p','workspace-note','Local test: create an unsaved blank TextEdit document, type a test sentence and read it back. No Groq usage or data transfer.'),actionButton('Test TextEdit control',null,'page-secondary',async()=>{accessMessage.textContent='Testing locally…';try{const result=await post('/api/app-control/test',{});accessMessage.textContent=result.message;}catch(error){accessMessage.textContent=error.message;}}));}
  if(runtime?.setup.platform==='darwin')appControls.append(actionButton('Check Spotify results',null,'page-secondary',async()=>{accessMessage.textContent='Reading Spotify locally…';try{const result=await post('/api/app-control/spotify-check',{});accessMessage.textContent=result.message;}catch(error){accessMessage.textContent=error.message;}}),element('p','workspace-note','Reads the current Spotify search without changing it, starting playback or using Groq.'));
  card.append(appControls);
  card.append(element('p','workspace-note','Computer tools: open apps, websites and workspace files; volume; Music/Spotify playback. macOS may request Automation permission; Windows uses its installed-app and media APIs. App interaction uses observed Accessibility/UI Automation controls; pixel-only interfaces are unavailable.'));
  card.append(renderGroqUsage());
  return card;
}

function renderGroqUsage(){
  const usage=element('section','groq-usage');usage.append(element('h3','','Groq usage'),element('p','workspace-note','GPT-OSS 120B · reported by Groq after each AI request.'));
  const quota=runtime?.setup.quota;
  for(const [key,label] of [['requests','Requests per day'],['tokens','Tokens per minute']]) {
    const sample=quota?.windows?.find(w=>w.key===key),row=element('div','quota-row');
    const heading=element('div','quota-heading');heading.append(element('span','',label),element('span','quota-count',sample?.percent!==null&&sample?.percent!==undefined?`${Math.round(sample.percent)}% used`:'Awaiting data'));row.append(heading);
    const bar=element('progress','quota-bar');bar.max=100;bar.value=sample?.percent??0;bar.setAttribute('aria-label',label+' usage');if(sample?.percent===null||sample?.percent===undefined){bar.removeAttribute('value');bar.classList.add('is-unknown');}row.append(bar);
    const amount=sample?.remaining!==null&&sample?.remaining!==undefined?`${sample.remaining.toLocaleString()} remaining${sample.limit!==null?' of '+sample.limit.toLocaleString():''}`:'Make an AI request to load your current limits.';
    const reset=sample?.resetAt?` · ${sample.resetAt>Date.now()?'reset estimate '+new Date(sample.resetAt).toLocaleTimeString():'window may have reset; awaiting next request'}`:'';row.append(element('p','workspace-note',amount+reset));usage.append(row);
  }
  if(quota?.observedAt)usage.append(element('small','workspace-note','Last reported '+new Date(quota.observedAt).toLocaleTimeString()+'. Other account activity may change these counts.'));
  const last=runtime?.setup.lastUsage;if(last)usage.append(element('p','workspace-note',`Last AI step: ${last.input.toLocaleString()} input tokens + ${last.output.toLocaleString()} output tokens${last.cached?' · '+last.cached.toLocaleString()+' input tokens cached':''}. App requests may need several AI steps; each step reads the current context.`));
  const limits=element('a','quota-link','View all account limits');limits.href='https://console.groq.com/settings/limits';limits.target='_blank';limits.rel='noopener noreferrer';usage.append(limits,element('p','workspace-note','Daily token and per-minute request totals are not included in these response headers.'));
  return usage;
}

playStartup(app);
void refreshRuntime(true);
const events = new EventSource('/api/events');
events.onmessage = event => { const data = JSON.parse(event.data); if (data.type === 'reminder') { toast(`${data.task.title} · ${data.task.detail}`); if (data.task.status === 'complete' && !requesting && !voicePreview) void speak(`Reminder: ${data.task.title}`); } void refreshRuntime(); };
events.onerror = () => { if (!requesting) $('#request-status').textContent = 'Local companion disconnected. Reconnecting…'; };
window.addEventListener('pagehide', () => { events.close(); stopSpeech(); clearTimeout(recordingTimer); microphone?.getTracks().forEach(track => track.stop()); });


function renderAnswer(node, text) {
  node.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks: true }), { ALLOWED_TAGS: ['p','strong','em','code','pre','br','ul','ol','li','blockquote','a','h1','h2','h3','h4','table','thead','tbody','tr','th','td','hr'], ALLOWED_ATTR: ['href','title'] });
  for (const link of node.querySelectorAll('a')) { if (!/^https?:\/\//i.test(link.getAttribute('href') || '')) link.removeAttribute('href'); link.rel = 'noopener noreferrer'; }
}
