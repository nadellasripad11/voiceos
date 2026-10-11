'use strict';
/**
 * Carrying the island around.
 *
 *   node scripts/test-move.js
 *
 * The island sits on top of everything, which is the point of it and also the
 * problem: when it is showing an answer it covers the row where a browser
 * keeps its tabs. So it has to be movable, and moving it has to be exact —
 * an island that lags behind the cursor or drifts away from it over a long
 * drag feels broken in a way that is hard to describe and easy to notice.
 *
 * It also has to stay reachable. It is the only way to get at the assistant,
 * so dragging it off the edge of the screen must not be able to lose it.
 */
const { movedBounds, clampToDisplays, nearestDisplay } = require('../src/core/ui/move');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};
const same = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const ISLAND = { x: 760, y: 0, width: 400, height: 48 };
const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 };

console.log('\nIt goes where the pointer takes it:');
{
  // Grabbed in the middle of the island, moved down and left.
  const grab = { x: 960, y: 24 };
  const r = movedBounds(ISLAND, grab, { x: 700, y: 500 });
  check('it follows by the same offset the pointer moved',
    r.x === 500 && r.y === 476, JSON.stringify(r));
  check('and keeps its size', r.width === 400 && r.height === 48, JSON.stringify(r));
}
{
  const grab = { x: 960, y: 24 };
  check('not moving the pointer does not move it',
    same(movedBounds(ISLAND, grab, grab), ISLAND));
}
{
  // Where it was grabbed is where it stays under the cursor: grabbing the left
  // edge and dropping at x means the left edge is at x.
  const r = movedBounds(ISLAND, { x: 760, y: 10 }, { x: 300, y: 10 });
  check('the grab point stays under the cursor', r.x === 300, JSON.stringify(r));
}

console.log('\nA long drag does not drift:');
{
  // This is why the position is absolute rather than a running sum of deltas.
  // Replayed as deltas, 400 small steps of 2.5px would each round to 2 or 3
  // and the island would end up somewhere the pointer is not.
  const grab = { x: 960, y: 24 };
  let last = null;
  for (let i = 0; i <= 400; i++) {
    last = movedBounds(ISLAND, grab, { x: 960 + i * 2.5, y: 24 + i * 1.5 });
  }
  const pointerMovedX = 400 * 2.5;
  const pointerMovedY = 400 * 1.5;
  check('after 400 steps it is exactly where the pointer is',
    last.x === ISLAND.x + pointerMovedX && last.y === ISLAND.y + pointerMovedY,
    JSON.stringify({ got: last, wantX: ISLAND.x + pointerMovedX, wantY: ISLAND.y + pointerMovedY }));

  check('and a dropped event in the middle changes nothing',
    same(movedBounds(ISLAND, grab, { x: 1960, y: 624 }), last),
    'the result must depend only on where the pointer is now');
}

console.log('\nIt cannot be dragged somewhere it cannot be clicked:');
{
  const displays = [SCREEN];
  const far = movedBounds(ISLAND, { x: 960, y: 24 }, { x: 40000, y: 40000 });
  const clamped = clampToDisplays(far, displays, 80);
  const onScreen =
    clamped.x < SCREEN.width && clamped.x + clamped.width > 0 &&
    clamped.y < SCREEN.height && clamped.y + clamped.height > 0;
  check('dragged far off the right it stays reachable', onScreen, JSON.stringify(clamped));
  // The island is 48px tall, so the vertical margin is the whole of it:
  // the rule is "this much, or all of it if it is smaller".
  check('at least the margin is still showing',
    SCREEN.width - clamped.x >= 80 && SCREEN.height - clamped.y >= Math.min(80, ISLAND.height),
    JSON.stringify(clamped));

  const offLeft = clampToDisplays({ x: -3000, y: 400, width: 400, height: 48 }, displays, 80);
  check('and the same off the left', offLeft.x + offLeft.width >= 80, JSON.stringify(offLeft));

  const offTop = clampToDisplays({ x: 700, y: -3000, width: 400, height: 48 }, displays, 80);
  check('and off the top', offTop.y + offTop.height >= Math.min(80, 48), JSON.stringify(offTop));
}

console.log('\nSomewhere legitimate is left alone:');
{
  const displays = [SCREEN];
  for (const [name, b] of [
    ['against the top edge', { x: 760, y: 0, width: 400, height: 48 }],
    ['against the bottom edge', { x: 760, y: 1032, width: 400, height: 48 }],
    ['tucked mostly off the right', { x: 1800, y: 300, width: 400, height: 48 }],
    ['in the middle', { x: 700, y: 500, width: 400, height: 48 }]
  ]) {
    check(`${name} is not nudged`, same(clampToDisplays(b, displays, 80), b),
      JSON.stringify(clampToDisplays(b, displays, 80)));
  }
}

console.log('\nWith a second monitor:');
{
  // A laptop with an external screen to its left, which is where negative
  // coordinates come from — a position that looks off-screen but is not.
  const left = { x: -1920, y: 0, width: 1920, height: 1080 };
  const displays = [left, SCREEN];
  const onLeft = { x: -1200, y: 300, width: 400, height: 48 };
  check('a negative position on the left-hand monitor is kept',
    same(clampToDisplays(onLeft, displays, 80), onLeft),
    JSON.stringify(clampToDisplays(onLeft, displays, 80)));

  const beyond = { x: -4000, y: 300, width: 400, height: 48 };
  const fixed = clampToDisplays(beyond, displays, 80);
  check('past the far edge it comes back onto that monitor, not the other one',
    fixed.x + fixed.width >= left.x + 80 && fixed.x < SCREEN.x, JSON.stringify(fixed));

  check('the nearest monitor is the one it is nearest',
    nearestDisplay({ x: -1000, y: 500, width: 400, height: 48 }, displays) === left);
  check('and that works the other way too',
    nearestDisplay({ x: 1000, y: 500, width: 400, height: 48 }, displays) === SCREEN);
}

console.log('\nNo display information at all:');
{
  // Better to put it where asked than to assume a screen that may not exist.
  const b = { x: 50, y: 60, width: 400, height: 48 };
  check('bounds pass through unchanged', same(clampToDisplays(b, [], 80), b));
  check('and with no list at all', same(clampToDisplays(b, null, 80), b));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
