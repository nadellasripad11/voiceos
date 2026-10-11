'use strict';
/**
 * Draws the console's two heavy pictures: the ink smoke and the inside of the
 * orb.
 *
 * They are drawn here, once, rather than in the app: tracing tens of thousands
 * of fibres took this laptop twenty seconds live, and the result never
 * changes. The app loads the finished images and only animates what is cheap
 * — the orb's rim and a slow drift.
 *
 *   npx electron scripts/render-scene-art.js
 *
 * Seeded throughout, so running it again gives the same pictures.
 */
(function () {
  // The design is 1672 x 941 with the orb at (836, 425). The smoke canvas
  // adds a margin all round, so a window that is not 16:9 still has smoke
  // in its edges.
  const DESIGN = { w: 1672, h: 941, cx: 836, cy: 425 };
  const MARGIN = { x: 400, y: 300 };

  function makeRandom(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  function makeNoise(seed) {
    const rand = makeRandom(seed);
    const perm = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const grad = (h, x, y) => {
      switch (h & 7) {
        case 0: return x + y; case 1: return x - y; case 2: return -x + y; case 3: return -x - y;
        case 4: return x; case 5: return -x; case 6: return y; default: return -y;
      }
    };
    const noise = (x, y) => {
      const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
      x -= Math.floor(x); y -= Math.floor(y);
      const u = fade(x), v = fade(y);
      const a = p[X] + Y, b = p[X + 1] + Y;
      const l1 = grad(p[a], x, y) + u * (grad(p[b], x - 1, y) - grad(p[a], x, y));
      const l2 = grad(p[a + 1], x, y - 1) + u * (grad(p[b + 1], x - 1, y - 1) - grad(p[a + 1], x, y - 1));
      return (l1 + v * (l2 - l1)) * 0.7;
    };
    noise.fbm = (x, y, oct = 4) => {
      let sum = 0, amp = 1, f = 1, norm = 0;
      for (let i = 0; i < oct; i++) { sum += noise(x * f, y * f) * amp; norm += amp; amp *= 0.5; f *= 2.03; }
      return sum / norm;
    };
    return noise;
  }

  const rad = (d) => d * Math.PI / 180;

  /*
   * Where the console has words, in design pixels. Specks of ink are kept out
   * of these: a dot in the middle of a word reads as a typo, and the design
   * keeps its text on clean paper.
   */
  const TEXT_ZONES = [
    [20, 20, 500, 330],     // name, greeting, motto
    [20, 340, 340, 600],    // navigation
    [470, 70, 640, 200],    // phases
    [1280, 20, 1672, 125],  // clock and icons
    [1290, 150, 1660, 710], // right-hand cards
    [25, 700, 495, 875],    // system status
    [590, 740, 1080, 900],  // greeting and ask box
    [1490, 770, 1660, 880]  // tagline
  ];
  const inText = (x, y) => TEXT_ZONES.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  /*
   * Arms of ink, read off the design: a broad X — the two upper arms leaning
   * outwards, the two lower ones heavier — and thin horizontal wisps. Angles
   * are canvas angles (y down); bend curls an arm as it goes.
   */
  const ARMS = [
    { a: -128, spread: 16, len: 760, weight: 1.0, bend: -0.35, curl: 1.0 },
    { a: -148, spread: 8, len: 620, weight: 0.45, bend: 0.3, curl: 1.2 },
    { a: -60, spread: 13, len: 700, weight: 0.85, bend: 0.25, curl: 1.0 },
    { a: -32, spread: 10, len: 1050, weight: 0.6, bend: -0.25, curl: 0.9 },
    { a: 132, spread: 15, len: 800, weight: 0.95, bend: 0.3, curl: 1.0 },
    { a: 162, spread: 7, len: 1000, weight: 0.3, bend: -0.12, curl: 0.8 },
    { a: 50, spread: 14, len: 800, weight: 0.95, bend: -0.3, curl: 1.0 },
    { a: 72, spread: 9, len: 700, weight: 0.5, bend: 0.4, curl: 1.1 },
    { a: 2, spread: 4, len: 760, weight: 0.32, bend: 0.06, curl: 0.6 },
    { a: 179, spread: 4, len: 820, weight: 0.3, bend: -0.05, curl: 0.6 }
  ];

  /** Ink, darkest first. Most fibres are near-black navy; a few are blue. */
  const INKS = [
    [8, 16, 34], [12, 24, 48], [20, 38, 72], [34, 62, 110], [58, 98, 160], [92, 138, 205]
  ];

  function drawSmoke() {
    const W = DESIGN.w + MARGIN.x * 2;
    const H = DESIGN.h + MARGIN.y * 2;
    const cx = DESIGN.cx + MARGIN.x;
    const cy = DESIGN.cy + MARGIN.y;

    const fibres = document.createElement('canvas');
    fibres.width = W; fibres.height = H;
    const f = fibres.getContext('2d');
    f.lineCap = 'round';
    f.lineJoin = 'round';

    const noise = makeNoise(7);
    const rand = makeRandom(11);
    const gauss = () => (rand() + rand() + rand() + rand() - 2) / 2;

    /*
     * Each arm is a handful of strands, and each strand is a bundle of
     * fibres. Fibres in a strand read the same field, so they move together
     * and twist into a rope; strands read different fields, so an arm splits
     * into several ropes; and each fibre carries its own small drift that
     * grows with distance, so the rope frays into wisps at the end. One shared
     * field made solid tubes, and one field per fibre made hair.
     */
    function trace(arm, armIndex) {
      const strand = Math.floor(rand() * 6);
      const strandOffset = (strand - 2.5) / 2.5; // -1..1 across the arm
      const start = rad(arm.a + strandOffset * arm.spread * 0.9 + gauss() * arm.spread * 0.45);
      const r0 = 146 + rand() * 30;
      let x = cx + Math.cos(start) * r0;
      let y = cy + Math.sin(start) * r0;
      let h = start + strandOffset * 0.2;
      const reach = arm.len * (0.2 + Math.pow(rand(), 0.55) * 0.9);
      const STEP = 2.2;
      const steps = Math.round(reach / STEP);
      const ink = INKS[Math.min(INKS.length - 1, Math.floor(Math.pow(rand(), 2.3) * INKS.length))];
      const width = 0.25 + Math.pow(rand(), 5) * 1.6;
      const alpha = (0.012 + Math.pow(rand(), 2.5) * 0.06) * (0.55 + arm.weight * 0.45);
      const fray = gauss() * 1.3;
      const fx = armIndex * 3.1 + strand * 1.7;
      const fy = strand * 2.3;

      const SEGS = 5;
      const per = Math.ceil(steps / SEGS);
      for (let s = 0; s < SEGS; s++) {
        f.beginPath();
        f.moveTo(x, y);
        for (let k = 0; k < per; k++) {
          const d = Math.hypot(x - cx, y - cy);
          const along = Math.min(1, Math.max(0, (d - 150) / arm.len));
          const field = noise.fbm(x * 0.0028 + fx, y * 0.0028 + fy, 4);
          const fine = noise.fbm(x * 0.0075 + fx, y * 0.0075 - fy, 3);
          const want = rad(arm.a) + arm.bend * along * 2.2
            + strandOffset * 0.35 * along
            + field * 2.2 * arm.curl * (0.3 + along)
            + fine * (0.45 + along * 1.6)
            + fray * along * along * 0.9;
          h += wrap(want - h) * 0.12;
          x += Math.cos(h) * STEP;
          y += Math.sin(h) * STEP;
          f.lineTo(x, y);
        }
        const fadeOut = Math.pow(1 - s / SEGS, 1.2);
        f.strokeStyle = `rgba(${ink[0]}, ${ink[1]}, ${ink[2]}, ${alpha * fadeOut})`;
        f.lineWidth = width * (1 - s * 0.12);
        f.stroke();
      }
      const fleckX = x + gauss() * 30 - MARGIN.x, fleckY = y + gauss() * 30 - MARGIN.y;
      if (rand() < 0.04 && !inText(fleckX, fleckY)) {
        f.fillStyle = `rgba(12, 20, 38, ${0.3 + rand() * 0.5})`;
        f.beginPath();
        f.arc(fleckX + MARGIN.x, fleckY + MARGIN.y, 0.5 + Math.pow(rand(), 5) * 3, 0, Math.PI * 2);
        f.fill();
      }
    }

    ARMS.forEach((arm, i) => {
      const count = Math.round(4200 * arm.weight);
      for (let n = 0; n < count; n++) trace(arm, i);
    });

    /*
     * The collar: dense, short, curling ink right against the orb, heaviest
     * on the diagonals. In the design the orb is half wrapped in it, and it
     * is most of what makes the smoke look like it comes out of the orb
     * rather than radiating from behind it.
     */
    const DIAGONALS = [-128, -58, 50, 132];
    for (let n = 0; n < 9000; n++) {
      const base = DIAGONALS[Math.floor(rand() * 4)];
      const start = rad(base + gauss() * 30);
      let x = cx + Math.cos(start) * (138 + rand() * 40);
      let y = cy + Math.sin(start) * (138 + rand() * 40);
      let h = start + gauss() * 0.6;
      const steps = 15 + Math.floor(Math.pow(rand(), 1.5) * 110);
      const seed = Math.floor(rand() * 4);
      f.beginPath();
      f.moveTo(x, y);
      for (let k = 0; k < steps; k++) {
        const field = noise.fbm(x * 0.009 + seed * 5.3, y * 0.009, 3);
        h += wrap(start + field * 3.2 - h) * 0.2;
        x += Math.cos(h) * 1.8;
        y += Math.sin(h) * 1.8;
        f.lineTo(x, y);
      }
      const ink = INKS[Math.floor(Math.pow(rand(), 2.5) * 4)];
      f.strokeStyle = `rgba(${ink[0]}, ${ink[1]}, ${ink[2]}, ${0.02 + Math.pow(rand(), 2) * 0.07})`;
      f.lineWidth = 0.3 + Math.pow(rand(), 4) * 1.4;
      f.stroke();
    }

    // Pale blue threads close to the orb: light caught in the smoke.
    for (let n = 0; n < 900; n++) {
      const armIndex = Math.floor(rand() * 8);
      const arm = ARMS[armIndex];
      const start = rad(arm.a + gauss() * arm.spread * 1.3);
      let x = cx + Math.cos(start) * (160 + rand() * 20);
      let y = cy + Math.sin(start) * (160 + rand() * 20);
      let h = start;
      f.beginPath();
      f.moveTo(x, y);
      const steps = 12 + Math.floor(rand() * 45);
      for (let k = 0; k < steps; k++) {
        const field = noise.fbm(x * 0.0026 + armIndex * 3.1, y * 0.0026, 4);
        h += wrap(rad(arm.a) + field * 2.4 * arm.curl * 0.5 - h) * 0.14;
        x += Math.cos(h) * 2.2;
        y += Math.sin(h) * 2.2;
        f.lineTo(x, y);
      }
      f.strokeStyle = `rgba(110, 165, 240, ${0.05 + rand() * 0.12})`;
      f.lineWidth = 0.4 + rand() * 0.7;
      f.stroke();
    }

    // Compose: the smoke itself is a density field (soft masses that tear
    // into wisps, like the reference); the traced fibres are only a faint
    // layer of strands on top of it.
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const o = out.getContext('2d');
    o.imageSmoothingQuality = 'high';
    o.drawImage(smokeField(W, H, cx, cy, noise), 0, 0, W, H);
    o.filter = 'blur(10px)';
    o.globalAlpha = 0.35;
    o.drawImage(fibres, 0, 0);
    o.filter = 'blur(1.5px)';
    o.globalAlpha = 0.32;
    o.drawImage(fibres, 0, 0);
    o.filter = 'none';
    o.globalAlpha = 1;
    o.drawImage(fibres, 0, 0);

    // Loose particles in the air.
    for (let n = 0; n < 260; n++) {
      const arm = ARMS[Math.floor(rand() * ARMS.length)];
      const d = 190 + Math.pow(rand(), 0.8) * arm.len * 0.9;
      const a = rad(arm.a + gauss() * arm.spread * 1.8);
      const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d;
      if (inText(px - MARGIN.x, py - MARGIN.y)) continue;
      o.fillStyle = `rgba(14, 24, 46, ${0.2 + rand() * 0.6})`;
      o.beginPath();
      o.arc(px, py, 0.4 + Math.pow(rand(), 6) * 2.4, 0, Math.PI * 2);
      o.fill();
    }
    return out;
  }

  /**
   * Ink in water, pixel by pixel, at half resolution (it is soft anyway).
   *
   * Domain-warped noise gives the turbulent masses; its ridges give the thin
   * torn wisps at their edges. Both are shaped into the arms by an angular
   * mask that widens and bends with distance, and turn bluer near the orb.
   */
  function smokeField(W, H, cx, cy, noise) {
    const S = 0.5;
    const w = Math.round(W * S), h = Math.round(H * S);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const px = img.data;
    const warp = makeNoise(41);
    const arms = ARMS.map((a) => ({ ...a, r: rad(a.a) }));
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = i / S, y = j / S;
        const dx = x - cx, dy = y - cy;
        const r = Math.hypot(dx, dy);
        if (r < 120) continue;
        // Warp first: everything that follows reads a twisted copy of space.
        const qx = x + 140 * warp.fbm(x * 0.0022, y * 0.0022, 3);
        const qy = y + 140 * warp.fbm(x * 0.0022 + 7.3, y * 0.0022 - 3.1, 3);
        const th = Math.atan2(qy - cy, qx - cx);
        let mask = 0;
        for (const a of arms) {
          const along = Math.min(1, (r - 150) / a.len);
          let d = th - (a.r + a.bend * along * 1.6);
          d = Math.atan2(Math.sin(d), Math.cos(d));
          const width = rad(a.spread * 0.7 + 5 + along * 15);
          const fade = Math.pow(Math.max(0, 1 - (r - 150) / (a.len * 0.95)), 2);
          mask += Math.exp(-(d * d) / (width * width)) * fade * a.weight;
        }
        if (mask < 0.01) continue;
        const cloud = 0.5 + 0.5 * noise.fbm(qx * 0.0045, qy * 0.0045, 5);
        const ridge = Math.pow(1 - Math.abs(noise.fbm(qx * 0.007 + 11, qy * 0.007, 4)), 6);
        // Near the orb the ink is dense; further out it is mostly wisps.
        const near = Math.max(0, 1 - (r - 140) / 330);
        let dens = mask * (Math.pow(cloud, 2.6) * (0.35 + near * 1.6) + ridge * 0.55);
        dens = Math.min(1, dens * 1.7);
        if (dens < 0.004) continue;
        const blue = Math.min(1, near * 0.8 + ridge * 0.35) * (0.5 + 0.5 * cloud);
        const k = (j * w + i) * 4;
        px[k] = 12 + blue * 58;
        px[k + 1] = 22 + blue * 92;
        px[k + 2] = 46 + blue * 150;
        px[k + 3] = Math.round(255 * Math.pow(dens, 1.15) * 0.92);
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /**
   * The inside of the orb: a dark sphere full of fine blue lightning.
   * The app spins this slowly and draws the live rim over it.
   */
  function drawCore(size = 680) {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const x0 = c.getContext('2d');
    const C = size / 2;
    const R = size / 2 - 2;
    const rand = makeRandom(23);
    const noise = makeNoise(29);

    let g = x0.createRadialGradient(C - R * 0.25, C - R * 0.3, R * 0.05, C, C, R);
    g.addColorStop(0, '#0f2142');
    g.addColorStop(0.5, '#050c1b');
    g.addColorStop(0.92, '#01040a');
    g.addColorStop(1, '#0b1d3f');
    x0.fillStyle = g;
    x0.beginPath();
    x0.arc(C, C, R, 0, Math.PI * 2);
    x0.fill();

    x0.save();
    x0.beginPath();
    x0.arc(C, C, R, 0, Math.PI * 2);
    x0.clip();
    x0.globalCompositeOperation = 'lighter';

    // Cloud, so there is depth behind the lightning.
    for (let i = 0; i < 40; i++) {
      const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * R * 0.95;
      const px = C + Math.cos(a) * d, py = C + Math.sin(a) * d;
      const r = R * (0.15 + rand() * 0.35);
      g = x0.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(40, 80, 160, ${0.04 + rand() * 0.06})`);
      g.addColorStop(1, 'rgba(40, 80, 160, 0)');
      x0.fillStyle = g;
      x0.fillRect(0, 0, size, size);
    }

    // Lightning: branching, jagged, brightest towards the rim where the
    // design has most of it.
    function bolt(x, y, ang, len, width, bright, depth) {
      const pts = [[x, y]];
      for (let k = 0; k < len; k++) {
        ang += (rand() - 0.5) * 0.55 + noise(x * 0.015, y * 0.015) * 0.25;
        x += Math.cos(ang) * 3;
        y += Math.sin(ang) * 3;
        pts.push([x, y]);
        if (depth < 3 && rand() < 0.035) bolt(x, y, ang + (rand() - 0.5) * 1.6, len * 0.5, width * 0.7, bright * 0.8, depth + 1);
      }
      for (const [w, a, col] of [[width * 6, bright * 0.08, '90, 150, 255'], [width * 2.5, bright * 0.25, '120, 175, 255'], [width * 0.8, bright, '225, 238, 255']]) {
        x0.beginPath();
        x0.moveTo(pts[0][0], pts[0][1]);
        for (const [px, py] of pts) x0.lineTo(px, py);
        x0.strokeStyle = `rgba(${col}, ${a})`;
        x0.lineWidth = w;
        x0.stroke();
      }
    }
    for (let i = 0; i < 22; i++) {
      const a = rand() * Math.PI * 2;
      const d = R * (0.55 + Math.pow(rand(), 0.35) * 0.45);
      const nearRim = d / R;
      bolt(C + Math.cos(a) * d, C + Math.sin(a) * d, rand() * Math.PI * 2,
        20 + rand() * 45, 0.4 + rand() * 0.6, 0.08 + nearRim * nearRim * 0.5, 0);
    }

    // Plasma: thin bright ridges of warped noise, strongest toward the rim.
    {
      const pc = document.createElement('canvas');
      pc.width = size; pc.height = size;
      const pctx = pc.getContext('2d');
      const img = pctx.createImageData(size, size);
      const d = img.data;
      const warp = makeNoise(57);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const rr = Math.hypot(x - C, y - C) / R;
          if (rr > 1) continue;
          const wx = x + 40 * warp.fbm(x * 0.008, y * 0.008, 3);
          const wy = y + 40 * warp.fbm(x * 0.008 + 5, y * 0.008, 3);
          const ridge = Math.pow(1 - Math.abs(noise.fbm(wx * 0.011, wy * 0.011, 4)), 16);
          const haze = 0.5 + 0.5 * noise.fbm(wx * 0.004, wy * 0.004, 3);
          const edge = Math.pow(Math.max(0, (rr - 0.25) / 0.75), 1.6);
          const v = Math.min(1, ridge * (0.1 + edge * 0.75) + haze * edge * 0.08);
          const k = (y * size + x) * 4;
          d[k] = 120 + v * 110; d[k + 1] = 170 + v * 75; d[k + 2] = 255; d[k + 3] = Math.round(v * 255);
        }
      }
      pctx.putImageData(img, 0, 0);
      x0.drawImage(pc, 0, 0);
    }

    // Light pooled under the rim.
    g = x0.createRadialGradient(C, C, R * 0.7, C, C, R);
    g.addColorStop(0, 'rgba(80, 140, 255, 0)');
    g.addColorStop(0.85, 'rgba(110, 170, 255, 0.22)');
    g.addColorStop(1, 'rgba(170, 210, 255, 0.55)');
    x0.fillStyle = g;
    x0.fillRect(0, 0, size, size);
    x0.restore();
    return c;
  }

  window.renderArt = function renderArt() {
    const t0 = performance.now();
    const smoke = drawSmoke();
    const t1 = performance.now();
    const core = drawCore();
    return {
      smoke: smoke.toDataURL('image/webp', 0.86),
      core: core.toDataURL('image/webp', 0.9),
      ms: { smoke: Math.round(t1 - t0), core: Math.round(performance.now() - t1) },
      size: { w: smoke.width, h: smoke.height, margin: MARGIN }
    };
  };

  /** For looking at it in a browser while tuning. */
  window.preview = function preview() {
    const art = window.renderArt();
    document.getElementById('smoke').src = art.smoke;
    document.getElementById('core').src = art.core;
    document.getElementById('info').textContent = JSON.stringify(art.ms) + ' smoke ' + Math.round(art.smoke.length / 1024) + 'KB core ' + Math.round(art.core.length / 1024) + 'KB';
    return art.ms;
  };
})();
