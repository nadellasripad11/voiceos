'use strict';
/**
 * Targeting overlay renderer.
 *
 * Draws an outline around whatever the main process reports is under the
 * cursor. Purely a display: it never reads the screen itself and never takes
 * input.
 */

const frame = document.getElementById('frame');
const tag = document.getElementById('tag');

// Screen coordinates arrive from the main process; the window is positioned to
// cover the whole display, so its origin is subtracted to get page coordinates.
let origin = { x: 0, y: 0 };

window.voiceos.onTarget((payload) => {
  if (!payload || !payload.bounds) {
    frame.hidden = true;
    return;
  }

  const { bounds, label, screen } = payload;
  if (screen) origin = screen;

  const left = bounds.x - origin.x;
  const top = bounds.y - origin.y;

  // A target the size of the whole screen is the desktop or a root window, not
  // something worth outlining.
  if (bounds.width <= 2 || bounds.height <= 2) { frame.hidden = true; return; }
  if (bounds.width >= window.innerWidth * 0.98 && bounds.height >= window.innerHeight * 0.98) {
    frame.hidden = true;
    return;
  }

  frame.style.left = `${left}px`;
  frame.style.top = `${top}px`;
  frame.style.width = `${bounds.width}px`;
  frame.style.height = `${bounds.height}px`;
  // Flip the label below when the outline is near the top of the screen.
  frame.dataset.flip = top < 34 ? 'true' : 'false';

  tag.textContent = label || 'Ask about this';
  frame.hidden = false;
});
