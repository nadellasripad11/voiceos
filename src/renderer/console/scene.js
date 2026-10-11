'use strict';
/**
 * The parts of the console that move: the orb's rim, and the two small woven
 * waves. Also fits the stage to the window.
 *
 * The smoke and the inside of the orb are pictures (art/, drawn once by
 * scripts/render-scene-art.js). Tracing them live cost this laptop twenty
 * seconds of CPU at every launch for an image that never changes.
 *
 * What is drawn here is cheap: a rim that follows the microphone and a few
 * dozen lines. It runs at ~6fps when nothing is happening, 30 when something
 * is, and not at all when the window is hidden (requestAnimationFrame stops
 * on its own).
 */
(function () {
  const DESIGN_W = 1672;
  const DESIGN_H = 941;
  const CX = 836;
  const CY = 425;

  // --- noise ----------------------------------------------------------------
  // Classic 2D Perlin, seeded so the rim moves the same way on every launch.
  function makeNoise(seed) {
    const p = new Uint8Array(512);
    const perm = Array.from({ length: 256 }, (_, i) => i);
    let s = seed >>> 0;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const grad = (h, x, y) => {
      switch (h & 7) {
        case 0: return x + y; case 1: return x - y; case 2: return -x + y; case 3: return -x - y;
        case 4: return x; case 5: return -x; case 6: return y; default: return -y;
      }
    };
    return function noise(x, y) {
      const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
      x -= Math.floor(x); y -= Math.floor(y);
      const u = fade(x), v = fade(y);
      const a = p[X] + Y, b = p[X + 1] + Y;
      const l1 = grad(p[a], x, y) + u * (grad(p[b], x - 1, y) - grad(p[a], x, y));
      const l2 = grad(p[a + 1], x, y - 1) + u * (grad(p[b + 1], x - 1, y - 1) - grad(p[a + 1], x, y - 1));
      return (l1 + v * (l2 - l1)) * 0.7; // roughly -1..1
    };
  }

  // --- fitting the stage to the window -----------------------------------
  const view = { scale: 1, x: 0, y: 0, dpr: 1 };

  function fit() {
    const stage = document.getElementById('stage');
    const W = window.innerWidth, H = window.innerHeight;
    const scale = Math.min(W / DESIGN_W, H / DESIGN_H);
    view.scale = scale;
    view.x = (W - DESIGN_W * scale) / 2;
    view.y = (H - DESIGN_H * scale) / 2;
    view.dpr = window.devicePixelRatio || 1;
    if (stage) stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${scale})`;
  }

  /** Backing-store density for a canvas that lives inside the scaled stage. */
  function density() {
    return Math.min(2, Math.max(1, view.scale * view.dpr));
  }

  // --- the orb --------------------------------------------------------------
  const orb = { level: 0, shown: 0, state: 'idle', t: 0, last: 0, noise: makeNoise(3) };
  const OR = 162; // radius of the dark body, in design pixels

  function sizeCanvas(canvas, w, h) {
    const k = density();
    const want = [Math.round(w * k), Math.round(h * k)];
    if (canvas.width !== want[0] || canvas.height !== want[1]) {
      canvas.width = want[0];
      canvas.height = want[1];
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(k, 0, 0, k, 0, 0);
    return ctx;
  }

  function drawOrb(now) {
    const canvas = document.getElementById('orb');
    if (!canvas) return;
    const ctx = sizeCanvas(canvas, 520, 520);
    const n = orb.noise;
    const c = 260;
    const busy = orb.state === 'thinking' ? 2.6 : orb.state === 'speaking' ? 1.7 : orb.state === 'listening' ? 1.3 : 0.6;
    orb.t += 0.016 * busy;
    const t = orb.t;
    // Ease the level, so the rim breathes rather than flickers.
    orb.shown += (orb.level - orb.shown) * 0.3;
    const speak = orb.state === 'speaking' ? (Math.sin(now / 140) * 0.5 + 0.5) * 0.35 : 0;
    const energy = Math.min(1, orb.shown + speak + (orb.state === 'thinking' ? 0.25 : 0));
    const R = OR + energy * 3;

    ctx.clearRect(0, 0, 520, 520);

    // Light around it. Transparent inside the body, so the turning core
    // underneath shows through untinted.
    const outer = R + 95;
    const g = ctx.createRadialGradient(c, c, 0, c, c, outer);
    g.addColorStop(0, 'rgba(150, 195, 255, 0)');
    g.addColorStop((OR - 16) / outer, 'rgba(150, 195, 255, 0)');
    g.addColorStop(OR / outer, `rgba(190, 220, 255, ${0.55 + energy * 0.3})`);
    g.addColorStop((R + 22) / outer, `rgba(140, 185, 255, ${0.28 + energy * 0.15})`);
    g.addColorStop(1, 'rgba(120, 170, 250, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 520, 520);

    // The rim: a few jagged circles laid over each other, which is what
    // makes it read as electrical rather than drawn with a compass.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let pass = 0; pass < 4; pass++) {
      ctx.beginPath();
      const N = 180;
      for (let k = 0; k <= N; k++) {
        const a = (k / N) * Math.PI * 2;
        const j = n(Math.cos(a) * 2.2 + pass * 7, Math.sin(a) * 2.2 + t * 0.8) * (3 + energy * 5)
          + n(a * 9, t * 2 + pass) * (1 + energy * 2);
        const r = R + j;
        const px = c + Math.cos(a) * r, py = c + Math.sin(a) * r;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      const wide = pass === 0;
      ctx.strokeStyle = wide ? `rgba(120, 175, 255, ${0.4 + energy * 0.2})` : `rgba(235, 245, 255, ${0.75 + energy * 0.25})`;
      ctx.lineWidth = wide ? 16 : 2 + (3 - pass) * 0.7;
      ctx.stroke();
    }

    // Filaments escaping the rim.
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2 + n(i, t * 0.4) * 0.8;
      let x = c + Math.cos(a) * R, y = c + Math.sin(a) * R;
      let ang = a;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const len = 6 + Math.abs(n(i * 3.1, t)) * 40 * (0.6 + energy);
      for (let k = 0; k < len; k++) {
        ang += n(x * 0.05, y * 0.05 + t) * 0.6;
        x += Math.cos(ang) * 1.5;
        y += Math.sin(ang) * 1.5;
        ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(185, 215, 255, ${0.3 + energy * 0.3})`;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- the woven waves --------------------------------------------------------
  const waves = { activity: 0, shown: 0, phase: 0 };

  /**
   * A ribbon of fine lines, like the design's two wave panels. Amplitude is
   * what it is told — the microphone for the voice card, overall activity for
   * the status card — so a still wave means nothing is happening.
   */
  function drawWeave(canvas, w, h, { amp, width, lines, phase, taper, k1, k2, colour }) {
    if (!canvas) return;
    const ctx = sizeCanvas(canvas, w, h);
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    // A ribbon: one centre line, and the strands spread either side of it by
    // a width that itself swings through zero — which is where the ribbon
    // twists and the strands cross, as in the design.
    for (let i = 0; i < lines; i++) {
      const off = (i / (lines - 1) - 0.5) * 2;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 2.5) {
        const u = x / w;
        const env = taper ? Math.pow(Math.sin(Math.PI * u), 1.3) : 0.3 + 0.7 * Math.sin(Math.PI * u);
        const centre = Math.sin(u * k1 + phase) * amp * env;
        const spread = Math.sin(u * k2 - phase * 0.7 + 0.6) * width * env;
        const wobble = Math.sin(u * 11 + i * 0.45 + phase * 1.3) * 1.2 * env;
        const y = mid + centre + off * spread + wobble;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(${colour}, ${0.14 + 0.3 * (1 - Math.abs(off))})`;
      ctx.lineWidth = 0.55;
      ctx.stroke();
    }
  }

  function drawWaves() {
    waves.shown += (waves.activity - waves.shown) * 0.15;
    const busy = orb.state !== 'idle';
    waves.phase += busy ? 0.06 : 0.012;
    const mic = Math.min(1, orb.shown * 1.6);
    drawWeave(document.getElementById('voiceWave'), 290, 70, {
      amp: 13 + mic * 14, width: 13 + mic * 8, lines: 32, phase: waves.phase,
      taper: true, k1: 6.6, k2: 4.4, colour: '24, 38, 66'
    });
    drawWeave(document.getElementById('statusWave'), 245, 85, {
      amp: 21 + waves.shown * 8, width: 17 + waves.shown * 5, lines: 32, phase: waves.phase * 0.8 + 2.2,
      taper: false, k1: 6.2, k2: 3.1, colour: '24, 38, 66'
    });
  }

  /** Satellites take their place from data attributes; the CSP forbids inline styles. */
  function placeSatellites() {
    for (const el of document.querySelectorAll('.sat[data-x]')) {
      const r = Number(el.dataset.r);
      el.style.left = (Number(el.dataset.x) - r) + 'px';
      el.style.top = (Number(el.dataset.y) - r) + 'px';
      el.style.width = el.style.height = (r * 2) + 'px';
    }
  }

  // --- the loop ---------------------------------------------------------------
  // Idle costs six frames a second; anything happening gets a smooth 30.
  function loop(now) {
    const idle = orb.state === 'idle' && orb.level < 0.01;
    const interval = idle ? 160 : 33;
    if (now - orb.last >= interval) {
      orb.last = now;
      drawOrb(now);
      drawWaves();
    }
    requestAnimationFrame(loop);
  }

  // --- wiring -----------------------------------------------------------------
  function start() {
    fit();
    placeSatellites();
    requestAnimationFrame(loop);
    window.addEventListener('resize', fit);
  }

  window.Scene = {
    start,
    setState(name) {
      orb.state = name;
      waves.activity = name === 'idle' ? 0 : name === 'thinking' ? 0.9 : 0.6;
    },
    setLevel(v) { orb.level = Math.max(0, Math.min(1, v || 0)); }
  };
})();
