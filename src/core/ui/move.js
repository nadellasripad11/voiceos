'use strict';
/**
 * Where the island lands while it is being carried.
 *
 * Kept apart from the window code because it is arithmetic, and arithmetic
 * about screen positions is worth being able to check without opening a
 * window: an off-by-one here is a thing you only notice as a slow drift over
 * a long drag.
 *
 * Absolute, never cumulative. A drag reported as deltas accumulates every
 * rounding error and every dropped event, and the island ends up somewhere the
 * pointer is not. The pointer's own position is already exact, so the offset
 * from where it was grabbed is all that is needed.
 */

/**
 * The bounds the island should have, given where it was picked up.
 *
 * @param {{x:number,y:number,width:number,height:number}} origin where it was when grabbed
 * @param {{x:number,y:number}} grab the pointer at the moment it was grabbed
 * @param {{x:number,y:number}} pointer the pointer now
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function movedBounds(origin, grab, pointer) {
  return {
    x: Math.round(origin.x + (pointer.x - grab.x)),
    y: Math.round(origin.y + (pointer.y - grab.y)),
    width: origin.width,
    height: origin.height
  };
}

/**
 * Pulls bounds back until enough of the island is still on some screen.
 *
 * Without this the island can be dragged off the edge and left there, and
 * since it is the only way to reach the assistant there is then nothing to
 * click to get it back. A margin rather than full containment, because
 * tucking most of it off the edge is a legitimate thing to want.
 *
 * @param {object} bounds
 * @param {Array<{x,y,width,height}>} displays work areas
 * @param {number} keep how many pixels must remain on screen in each axis
 */
function clampToDisplays(bounds, displays, keep = 80) {
  if (!displays || !displays.length) return bounds;

  const visible = (b) => displays.some((d) => {
    const overlapX = Math.min(b.x + b.width, d.x + d.width) - Math.max(b.x, d.x);
    const overlapY = Math.min(b.y + b.height, d.y + d.height) - Math.max(b.y, d.y);
    return overlapX >= Math.min(keep, b.width) && overlapY >= Math.min(keep, b.height);
  });

  if (visible(bounds)) return bounds;

  // Nudge it back onto whichever screen it is closest to leaving.
  const target = nearestDisplay(bounds, displays);
  const needX = Math.min(keep, bounds.width);
  const needY = Math.min(keep, bounds.height);
  return {
    ...bounds,
    x: Math.min(Math.max(bounds.x, target.x - bounds.width + needX), target.x + target.width - needX),
    y: Math.min(Math.max(bounds.y, target.y - bounds.height + needY), target.y + target.height - needY)
  };
}

/** The display whose centre is closest to the island's. */
function nearestDisplay(bounds, displays) {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  let best = displays[0];
  let bestDist = Infinity;
  for (const d of displays) {
    const dx = d.x + d.width / 2 - cx;
    const dy = d.y + d.height / 2 - cy;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  return best;
}

module.exports = { movedBounds, clampToDisplays, nearestDisplay };
