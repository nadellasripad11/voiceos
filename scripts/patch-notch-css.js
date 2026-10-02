'use strict';
/** Applies the notch CSS changes. Written as a file so no shell mangles it. */
const fs = require('fs');
const p = 'src/renderer/notch/notch.css';
let c = fs.readFileSync(p, 'utf8');

// 1. The ledge is gone: a permanent black strip across the whole screen reads
//    as a defect rather than as part of the island.
c = c.replace(/\/\* The strip the island hangs from[\s\S]*?\.stage \{ position: relative; \}\n\n/, '');
c = c.replace(/\[data-position="bottom"\] \.ledge \{[^}]*\}\n/, '');
c = c.replace(/\.ledge \{[\s\S]*?\n\}\n/, '');

// 2. The island is draggable, so the stage must not force it to the top; its
//    position comes from the window, which the main process moves.
c = c.replace(/\.stage \{\n  display: flex;\n  flex-direction: column;\n  justify-content: flex-start;\n  align-items: center;\n  width: 100%;\n  height: 100%;\n  padding: 0 0 28px;\n\}/,
`.stage {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: center;
  width: 100%;
  height: 100%;
  padding: 0 0 28px;
}

/* Parked against the top bezel it is square where it meets the edge; floating
   free it is rounded all round, so the shape says whether it is docked. */
[data-docked="free"] .card { border-radius: var(--radius); margin-top: 6px; }
[data-docked="free"] .stage { padding-top: 6px; }

/* The bar is the drag handle. Controls inside it opt back out. */
.bar { -webkit-app-region: drag; cursor: grab; }
.bar:active { cursor: grabbing; }
.bar button, .bar input, .compose { -webkit-app-region: no-drag; }`);

// 3. Compose row, so the island can be typed into as well as spoken to.
c += `

/* --- type instead of speaking ---
   The window is normally not focusable so dictation lands in the user's own
   field. Clicking here asks the main process for focus, and gives it back on
   blur, so the two input methods cannot fight over it. */
.compose {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 10px 16px 12px;
  border-top: 1px solid var(--island-edge);
}
[data-state="idle"] .compose,
[data-state="answer"] .compose,
[data-state="error"] .compose { display: flex; }
[data-state="idle"] .compose { border-top: none; padding: 0 16px 11px; }

#composeInput {
  flex: 1;
  min-width: 0;
  font: inherit;
  font-size: 13.5px;
  color: var(--island-text);
  background: var(--island-raised);
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  padding: 8px 14px;
  outline: none;
}
#composeInput::placeholder { color: var(--island-faint); }
#composeInput:focus { border-color: rgba(10, 132, 255, 0.6); background: rgba(255, 255, 255, 0.1); }

.send {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  color: #fff;
  background: #0a84ff;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  opacity: 0.45;
  transition: opacity 140ms ease;
}
.send.is-ready { opacity: 1; }

/* --- head actions --- */
.head-actions { display: flex; gap: 4px; }
.icon-btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--island-faint);
  background: transparent;
  border: none;
  border-radius: var(--r-pill);
  cursor: pointer;
}
.icon-btn:hover { color: var(--island-text); background: var(--island-raised); }
.icon-btn.is-busy { color: #0a84ff; }

/* --- found --- */
.found-wrap {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--island-edge);
}
.found-wrap[hidden] { display: none; }
.found-label {
  display: block;
  font-size: 9.5px;
  font-weight: 650;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--island-faint);
  margin-bottom: 8px;
}
.found { margin-top: 0; padding-top: 0; border-top: none; }
`;

fs.writeFileSync(p, c);
console.log('ledge removed:', !c.includes('.ledge'));
console.log('drag handle:', c.includes('-webkit-app-region: drag'));
console.log('compose:', c.includes('#composeInput'));
