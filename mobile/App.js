/**
 * Jarvis on the phone: chat, approvals, notifications, and calling him.
 *
 * Talks to the same server as the website (myjarvis.pages.dev), signed in
 * with the same password; the phone keeps the session cookie. A call opens
 * the website's voice in a WebView, which shares that cookie.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Notifications from 'expo-notifications';
import * as Speech from 'expo-speech';
import Constants from 'expo-constants';
import { requestRecordingPermissionsAsync } from 'expo-audio';

const SITE = 'https://myjarvis.pages.dev';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
const C = { bg: '#eef2f7', card: '#ffffff', ink: '#13203a', muted: '#6b7890', navy: '#0f264e', line: 'rgba(40,56,82,0.14)' };

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false, shouldShowAlert: true })
});

async function api(path, body) {
  const res = await fetch(SITE + path, {
    method: body ? 'POST' : 'GET',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { const e = new Error('Sign in first.'); e.signedOut = true; throw e; }
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

const plain = (t) => String(t || '').replace(/[*_#`>]/g, '').replace(/\[(.*?)\]\((.*?)\)/g, '$1').trim();
function say(text) {
  Speech.stop();
  Speech.speak(plain(text).slice(0, 1200), { language: 'en-GB', rate: 1.05 });
}
const notifyNow = (title, body) => Notifications.scheduleNotificationAsync({ content: { title, body: plain(body).slice(0, 240) }, trigger: null }).catch(() => {});

/** Real push, when this app has an Expo project id (run `npx eas init` once). Otherwise the in-app checks do it. */
async function registerPush() {
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return;
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'Jarvis', importance: Notifications.AndroidImportance.HIGH });
  const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
  if (!projectId) return;
  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    await api('/api/push-token', { token: data });
  } catch { /* Expo Go on Android cannot get push tokens; the in-app checks still notify */ }
}

function SignIn({ onDone }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr('');
    try { await api('/api/login', { password: pw }); setPw(''); onDone(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <View style={s.center}>
      <View style={s.card}>
        <Text style={s.micro}>J.A.R.V.I.S.</Text>
        <Text style={s.h1}>Welcome back, sir.</Text>
        <Text style={s.muted}>Enter your Jarvis password.</Text>
        <TextInput style={s.input} value={pw} onChangeText={setPw} placeholder="Password" secureTextEntry autoCapitalize="none" onSubmitEditing={go} />
        <Pressable style={s.button} onPress={go} disabled={busy}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>Sign in</Text>}</Pressable>
        {err ? <Text style={s.error}>{err}</Text> : null}
      </View>
    </View>
  );
}

/** The website's voice, full screen, started as soon as it loads. */
function Call({ visible, onEnd }) {
  const web = useRef(null);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onEnd}>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <WebView
          ref={web}
          source={{ uri: `${SITE}/?call=1` }}
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          javaScriptEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          mediaCapturePermissionGrantType="grant"
          onLoadEnd={() => setTimeout(() => web.current?.injectJavaScript('window.jarvisCall && window.jarvisCall(); true;'), 1500)}
          style={{ flex: 1, backgroundColor: C.bg }}
        />
        <Pressable style={s.hangUp} onPress={() => { web.current?.injectJavaScript('window.jarvisHangUp && window.jarvisHangUp(); true;'); onEnd(); }}>
          <Text style={s.buttonText}>End call</Text>
        </Pressable>
      </SafeAreaView>
    </Modal>
  );
}

function Chat({ onSignedOut }) {
  const [items, setItems] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [calling, setCalling] = useState(false);
  const [laptop, setLaptop] = useState(false);
  const memory = useRef([]);
  const since = useRef(Date.now());
  const watching = useRef(new Set());

  const add = (m) => setItems((list) => [m, ...list]);
  const fail = (e) => { if (e.signedOut) onSignedOut(); else add({ id: `${Date.now()}`, who: 'jarvis', text: e.message }); };

  useEffect(() => {
    (async () => {
      try {
        const [h, m, sess] = await Promise.all([api('/api/convo'), api('/api/memory'), api('/api/session')]);
        memory.current = m.facts || [];
        setLaptop(Boolean(sess.laptop));
        setItems(h.items.flatMap((it, i) => [{ id: `a${i}`, who: 'jarvis', text: it.answer, source: it.source }, { id: `q${i}`, who: 'you', text: it.question, source: it.source }]));
      } catch (e) { fail(e); }
    })();
    registerPush();
  }, []);

  // Reminders, routine answers, finished laptop jobs: checked while the app is open.
  useEffect(() => {
    const check = async () => {
      try {
        const { items: news } = await api(`/api/inbox?since=${since.current}`);
        for (const it of news.reverse()) {
          since.current = Math.max(since.current, it.at);
          notifyNow(it.title, it.body);
          add({ id: `n${it.id}`, who: 'jarvis', text: `**${it.title}:** ${it.body}` });
        }
        setLaptop(Boolean((await api('/api/session')).laptop));
      } catch { /* next time */ }
    };
    const t = setInterval(check, 20000);
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') check(); });
    return () => { clearInterval(t); sub.remove(); };
  }, []);

  /** A job handed to the laptop: approvals as a dialog, the answer when it is done. */
  const watchJob = useCallback(async (id) => {
    if (watching.current.has(id)) return;
    watching.current.add(id);
    const until = Date.now() + 10 * 60000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2500));
      let st;
      try { st = await api(`/api/laptop?job=${encodeURIComponent(id)}`); } catch { continue; }
      const job = st.job;
      if (!job) break;
      if (job.status === 'confirm') {
        say(job.title || 'I need your approval, sir.');
        const yes = await new Promise((resolve) => Alert.alert(job.title || 'Approve this?', job.detail || '', [
          { text: 'Decline', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Approve', onPress: () => resolve(true) }
        ], { cancelable: false }));
        await api('/api/laptop/answer', { id, yes }).catch(() => {});
      }
      if (job.status === 'done') {
        const answer = (job.result && job.result.answer) || 'Done.';
        add({ id: `j${id}`, who: 'jarvis', text: answer, source: 'laptop' });
        say(answer);
        if (AppState.currentState !== 'active') notifyNow('Done on your laptop', answer);
        break;
      }
    }
    watching.current.delete(id);
  }, []);

  const send = async () => {
    const q = text.trim();
    if (!q || busy) return;
    setText('');
    add({ id: `q${Date.now()}`, who: 'you', text: q });
    setBusy(true);
    try {
      const history = items.slice(0, 12).reverse().reduce((acc, m) => {
        if (m.who === 'you') acc.push({ question: m.text, answer: '' });
        else if (acc.length) acc[acc.length - 1].answer = m.text;
        return acc;
      }, []).slice(-6);
      const r = await api('/api/ask', { question: q, tz: TZ, history, memory: memory.current.slice(-60) });
      const answer = r.look ? 'Looking needs the camera: open the website, or call me and ask there.' : (r.answer || 'Done.');
      add({ id: `a${Date.now()}`, who: 'jarvis', text: answer });
      say(answer);
      if (r.memoryAdd && r.memoryAdd.length) memory.current.push(...r.memoryAdd);
      if (r.pendingJob) watchJob(r.pendingJob);
    } catch (e) { fail(e); }
    setBusy(false);
  };

  const startCall = async () => {
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) { Alert.alert('Microphone', 'Jarvis needs the microphone to talk.'); return; }
    Speech.stop();
    setCalling(true);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.header}>
        <View>
          <Text style={s.micro}>J.A.R.V.I.S.</Text>
          <Text style={s.mutedSmall}>{laptop ? 'Laptop connected' : 'Laptop offline'}</Text>
        </View>
        <Pressable style={s.callButton} onPress={startCall}><Text style={s.buttonText}>Call</Text></Pressable>
      </View>
      <FlatList
        inverted
        data={items}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 14 }}
        renderItem={({ item }) => (
          <View style={[s.bubble, item.who === 'you' ? s.you : s.jarvis]}>
            <Text style={item.who === 'you' ? s.youText : s.jarvisText} onPress={() => { const u = /\]\((\/api\/files\/[^)]+)\)/.exec(item.text); if (u) Linking.openURL(SITE + u[1]); }}>{plain(item.text)}</Text>
            {item.source && item.source !== 'website' ? <Text style={s.source}>{item.source}</Text> : null}
          </View>
        )}
      />
      <View style={s.composer}>
        <TextInput style={s.composerInput} value={text} onChangeText={setText} placeholder="Ask me anything, sir…" onSubmitEditing={send} returnKeyType="send" />
        <Pressable style={s.send} onPress={send} disabled={busy}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>↑</Text>}</Pressable>
      </View>
      <Call visible={calling} onEnd={() => setCalling(false)} />
    </KeyboardAvoidingView>
  );
}

export default function App() {
  const [signedIn, setSignedIn] = useState(null);
  useEffect(() => { api('/api/session').then((r) => setSignedIn(Boolean(r.signedIn))).catch(() => setSignedIn(false)); }, []);
  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="dark-content" />
      {signedIn === null ? <View style={s.center}><ActivityIndicator color={C.navy} /></View>
        : signedIn ? <Chat onSignedOut={() => setSignedIn(false)} /> : <SignIn onDone={() => setSignedIn(true)} />}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 380, backgroundColor: C.card, borderRadius: 20, padding: 24, gap: 12 },
  micro: { fontSize: 11, letterSpacing: 3, color: C.navy, fontWeight: '600' },
  h1: { fontSize: 26, fontWeight: '300', color: C.ink },
  muted: { fontSize: 13, color: C.muted },
  mutedSmall: { fontSize: 11, color: C.muted, marginTop: 2 },
  input: { height: 46, borderRadius: 12, borderWidth: 1, borderColor: C.line, paddingHorizontal: 14, fontSize: 15, color: C.ink, backgroundColor: '#f8fafc' },
  button: { height: 46, borderRadius: 12, backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  error: { color: '#c8423b', fontSize: 13 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  callButton: { backgroundColor: C.navy, borderRadius: 20, paddingHorizontal: 18, height: 38, alignItems: 'center', justifyContent: 'center' },
  bubble: { maxWidth: '86%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, marginVertical: 4 },
  you: { alignSelf: 'flex-end', backgroundColor: C.navy },
  jarvis: { alignSelf: 'flex-start', backgroundColor: C.card },
  youText: { color: '#fff', fontSize: 15, lineHeight: 21 },
  jarvisText: { color: C.ink, fontSize: 15, lineHeight: 21 },
  source: { fontSize: 10, color: C.muted, marginTop: 4, textTransform: 'uppercase', letterSpacing: 1 },
  composer: { flexDirection: 'row', gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.bg },
  composerInput: { flex: 1, height: 46, borderRadius: 23, backgroundColor: C.card, paddingHorizontal: 18, fontSize: 15, color: C.ink },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center' },
  hangUp: { position: 'absolute', bottom: 40, alignSelf: 'center', backgroundColor: '#c8423b', borderRadius: 28, paddingHorizontal: 30, height: 56, alignItems: 'center', justifyContent: 'center' }
});
