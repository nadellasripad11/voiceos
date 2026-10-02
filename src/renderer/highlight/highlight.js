'use strict';
/**
 * Cursor trail.
 *
 * Draws an ink line following the pointer while Agent Mode listens, so the user
 * can sweep over or circle what they are asking about and see exactly what was
 * marked. The trail fades from the tail so it reads as motion rather than as a
 * permanent scribble, and nothing is drawn while the pointer is still.
 */

const canvas = document.getElementById('trail');
const ctx = canvas.getContext('2d');

/** Points are {x, y, t}; t drives the fade. */
let points = [];
let active = false;
let raf = null;

const LIFETIME_MS = 1400;   // how long a point stays visible
const MIN_STEP = 2;         // ignore sub-pixel jitter so a still pointer draws nothing

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

window.voiceos.onPoint((payload) => {
  if (!payload) {
    // Session over: let the trail fade out rather than cutting it.
    active = false;
    return;
  }
  active = true;

  const last = points[points.length - 1];
  if (last) {
    const dx = payload.x - last.x;
    const dy = payload.y - last.y;
    // Only extend the trail when the pointer actually moved.
    if (Math.hypot(dx, dy) < MIN_STEP) return;
  }
  points.push({ x: payload.x, y: payload.y, t: performance.now() });
  if (!raf) raf = requestAnimationFrame(draw);
});

function draw(now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Drop points that have fully faded.
  points = points.filter((p) => now - p.t < LIFETIME_MS);

  if (points.length > 1) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const age = (now - b.t) / LIFETIME_MS;
      const life = Math.max(0, 1 - age);

      // Thickness and opacity both fall off toward the tail, which is what
      // makes it read as a stroke being drawn rather than a static line.
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(10, 132, 255, ${(life * 0.9).toFixed(3)})`;
      ctx.lineWidth = 2 + life * 4;
      ctx.stroke();

      // A soft halo under the brightest part of the stroke.
      if (life > 0.55) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = `rgba(90, 180, 255, ${((life - 0.55) * 0.5).toFixed(3)})`;
        ctx.lineWidth = 10 + life * 8;
        ctx.stroke();
      }
    }

    // A dot at the head, so the live end of the stroke is obvious.
    const head = points[points.length - 1];
    if (now - head.t < 160) {
      ctx.beginPath();
      ctx.arc(head.x, head.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(10, 132, 255, 0.95)';
      ctx.fill();
    }
  }

  if (points.length || active) {
    raf = requestAnimationFrame(draw);
  } else {
    raf = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}
