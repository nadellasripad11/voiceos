/**
 * Jarvis on the phone: the website's own interface, full screen, so the app
 * always looks and works like the site (chat, voice, approvals, files).
 *
 * What the app adds on top: phone notifications for reminders and finished
 * laptop jobs (the page hands them over), the microphone for voice, and links
 * the page cannot open itself (texts, calls, maps, other apps).
 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Platform, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { requestRecordingPermissionsAsync } from 'expo-audio';

const SITE = 'https://myjarvis.pages.dev';
const BG = '#eef1f6';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false, shouldShowAlert: true })
});

const plain = (t) => String(t || '').replace(/[*_#`>]/g, '').replace(/\[(.*?)\]\((.*?)\)/g, '$1').trim();

/** Real push needs an Expo project id (`npx eas init`); without one the page's own checks notify. */
async function pushToken() {
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return null;
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'Jarvis', importance: Notifications.AndroidImportance.HIGH });
  const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
  if (!projectId) return null;
  try { return (await Notifications.getExpoPushTokenAsync({ projectId })).data; } catch { return null; }
}

function Jarvis() {
  const web = useRef(null);
  const back = useRef(false);
  const [failed, setFailed] = useState(false);
  const [token, setToken] = useState(null);

  useEffect(() => {
    requestRecordingPermissionsAsync().catch(() => {});
    pushToken().then(setToken);
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!back.current) return false;
      web.current?.goBack();
      return true;
    });
    return () => sub.remove();
  }, []);

  // The page is signed in, so it registers the token with its own cookie.
  const sendToken = () => {
    if (token) web.current?.injectJavaScript(`fetch('/api/push-token',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token)}})}).catch(()=>{}); true;`);
  };
  useEffect(sendToken, [token]);

  const onMessage = (e) => {
    let m = {};
    try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (m.type === 'notify') Notifications.scheduleNotificationAsync({ content: { title: String(m.title || 'Jarvis'), body: plain(m.body).slice(0, 240) }, trigger: null }).catch(() => {});
  };

  // The site stays in the app; everything else (texts, calls, other sites) opens where it belongs.
  const onLink = (req) => {
    const url = req.url || '';
    if (url.startsWith(SITE) || url.startsWith('about:') || url.startsWith('blob:') || url.startsWith('data:')) return true;
    Linking.openURL(url).catch(() => {});
    return false;
  };

  if (failed) {
    return (
      <View style={s.center}>
        <Text style={s.micro}>J.A.R.V.I.S.</Text>
        <Text style={s.muted}>I could not reach the site, sir. Check the connection.</Text>
        <Pressable style={s.button} onPress={() => setFailed(false)}><Text style={s.buttonText}>Try again</Text></Pressable>
      </View>
    );
  }

  return (
    <WebView
      ref={web}
      source={{ uri: SITE }}
      style={{ flex: 1, backgroundColor: BG }}
      sharedCookiesEnabled
      thirdPartyCookiesEnabled
      javaScriptEnabled
      domStorageEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      mediaCapturePermissionGrantType="grant"
      allowsBackForwardNavigationGestures
      pullToRefreshEnabled
      setSupportMultipleWindows={false}
      startInLoadingState
      renderLoading={() => <View style={s.loading}><ActivityIndicator color="#0f264e" /></View>}
      onMessage={onMessage}
      onShouldStartLoadWithRequest={onLink}
      onNavigationStateChange={(nav) => { back.current = nav.canGoBack; }}
      onLoadEnd={sendToken}
      onError={() => setFailed(true)}
    />
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root} edges={['top', 'bottom']}>
        <StatusBar barStyle="dark-content" backgroundColor={BG} />
        <Jarvis />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: BG },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14, backgroundColor: BG },
  micro: { fontSize: 11, letterSpacing: 3, color: '#0f264e', fontWeight: '600' },
  muted: { fontSize: 14, color: '#6b7890', textAlign: 'center' },
  button: { height: 46, paddingHorizontal: 24, borderRadius: 12, backgroundColor: '#0f264e', alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' }
});
