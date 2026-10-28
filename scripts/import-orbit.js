'use strict';
/**
 * Brings the Orbit front end (karamvschool-ai/Orbit, used with the author's
 * permission) into web/, renamed J.A.R.V.I.S. and recoloured to VoiceOS's
 * navy and blue.
 *
 *   node scripts/import-orbit.js <path to an Orbit checkout>
 *
 * Recolouring keeps each colour's lightness and swaps its neutral grey for a
 * blue-tinted one, so every contrast the design relied on is unchanged — only
 * the hue moves. Pure white stays white.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(process.argv[2] || '../orbit-src');
const OUT = path.join(__dirname, '..', 'web');
const FILES = ['index.html', 'style.css', 'app.js', 'startup.js', 'singularity.js', 'core-field.js',
  'fluid-simulation.js', 'scene-layout.js', 'speech-playback.js', 'favicon.svg'];

/** Grey -> the same lightness in VoiceOS blue. Darker greys get deeper navy. */
function tint(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min > 24) return [r, g, b];          // already a colour: leave it
  if (r === 255 && g === 255 && b === 255) return [r, g, b];
  let l = (max + min) / 510;
  const h = 218 / 360;
  // Black has no hue to keep, so it would stay black. It becomes a deep blue
  // instead — the orb, the dark text, the active controls — lifted just
  // enough for the blue to show while staying the darkest thing on screen.
  if (l < 0.16) l = 0.13 + l * 0.6;
  const s = l < 0.2 ? 0.68 : l < 0.5 ? 0.42 : l < 0.85 ? 0.22 : 0.3;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t) => {
    t = (t + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(v * 255);
  };
  return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
}

function recolour(text) {
  return text
    .replace(/#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?\b/g, (m, hex, a = '') => {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return '#' + tint(r, g, b).map((v) => v.toString(16).padStart(2, '0')).join('') + a;
    })
    .replace(/#([0-9a-fA-F]{3})\b(?![0-9a-fA-F])/g, (m, hex) => {
      const [r, g, b] = [...hex].map((c) => parseInt(c + c, 16));
      return '#' + tint(r, g, b).map((v) => v.toString(16).padStart(2, '0')).join('');
    })
    .replace(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g, (m, r, g, b) => {
      const fn = m.startsWith('rgba') ? 'rgba' : 'rgb';
      return `${fn}(${tint(+r, +g, +b).join(',')}`;
    });
}

function rename(text, file) {
  let t = text
    .replace(/Orbit — Your personal assistant/g, 'J.A.R.V.I.S. — Your personal assistant')
    .replace(/<div class="orbit-wordmark" aria-label="Orbit">[\s\S]*?<\/div>/,
      '<div class="orbit-wordmark" aria-label="J.A.R.V.I.S."><span>J</span><span>A</span><span>R</span><span class="core-letter"></span><span>V</span><span>I</span><span>S</span></div>')
    .replace(/ORBIT \/ YOUR SPACE/g, 'J.A.R.V.I.S. / YOUR SPACE')
    .replace(/'ORBIT'/g, "'J.A.R.V.I.S.'")
    .replace(/YOUR ORBIT/g, 'YOUR J.A.R.V.I.S.')
    .replace(/I’m Orbit/g, 'I’m Jarvis')
    .replace(/aria-label="Orbit's response"/g, 'aria-label="Jarvis\'s response"')
    .replace(/aria-label="Message Orbit"/g, 'aria-label="Message Jarvis"')
    .replace(/send it into orbit/g, 'send it to Jarvis')
    .replace(/a calmer orbit/g, 'a calmer Jarvis');
  // Every remaining visible "Orbit" (a capitalised word in text and messages)
  // becomes Jarvis; lowercase class names like .orbit-app are left alone.
  if (file.endsWith('.js') || file.endsWith('.html')) t = t.replace(/\bOrbit\b/g, 'Jarvis');
  return t;
}

/** Layout changes the name needs: seven slots (J A R, the orb, V I S) instead of five. */
function layout(text, file) {
  // The orb is drawn by a shader in grey: one brightness, black at the centre.
  // It blends from VoiceOS navy to white instead, so the core is deep blue
  // and its glowing rim stays white.
  if (file === 'core-field.js') {
    return text.replace('gl_FragColor=vec4(vec3(rgb),alpha);', 'gl_FragColor=vec4(mix(vec3(.047,.11,.235),vec3(1.),rgb),alpha);');
  }
  if (file !== 'style.css') return text;
  return text
    .replace(/\r\n/g, '\n')
    .replace('width: 35.1%; max-width: 590px; min-width: 460px;', 'width: 44%; max-width: 740px; min-width: 560px;')
    .replace(/\.orbit-wordmark span:nth-child\((2|4)\) \{ transform: translateX\(-?\d+px\); \}\n/g, '')
    .replace(/\.orbit-wordmark \.core-letter \{ position: relative; left: 6px;([^}]*)\}/, '.orbit-wordmark .core-letter { position: relative; width: 120px;$1}');
}

fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
for (const f of FILES) {
  let text = fs.readFileSync(path.join(SRC, f), 'utf8');
  if (/\.(css|js|html|svg)$/.test(f)) text = recolour(text);
  text = layout(rename(text, f), f);
  fs.writeFileSync(path.join(OUT, f), text);
}
for (const a of fs.readdirSync(path.join(SRC, 'assets'))) {
  fs.copyFileSync(path.join(SRC, 'assets', a), path.join(OUT, 'assets', a));
}
// The two libraries the page imports, from npm rather than the Orbit checkout.
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'node_modules', 'marked', 'lib', 'marked.esm.js'), path.join(OUT, 'vendor', 'marked.js'));
fs.copyFileSync(path.join(__dirname, '..', 'node_modules', 'dompurify', 'dist', 'purify.es.mjs'), path.join(OUT, 'vendor', 'purify.js'));
console.log(`imported ${FILES.length} files and ${fs.readdirSync(path.join(OUT, 'assets')).length} assets into web/`);
