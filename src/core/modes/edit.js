'use strict';
/**
 * Edit Mode: select text anywhere, say what to do with it, get it back changed.
 *
 * "Make this more formal", "fix the grammar", "turn this into bullet points" —
 * spoken at a selection in any application, with the result written back over
 * it. The third of the three modes, alongside Dictation and Agent.
 *
 * Two decisions worth stating, because both are about not surprising anyone:
 *
 * It shares the dictation chord rather than adding one. There are exactly two
 * chords and that is deliberate; Edit is what the dictation chord means when
 * there is a selection to act on.
 *
 * Which means it has to tell an instruction from replacement text. Someone who
 * selects a word and says "Tuesday" wants the word replaced, not a short essay
 * about Tuesday. So the decision is made by a deterministic pattern first, and
 * anything that is not clearly an instruction is treated as plain dictation.
 * Guessing wrong in that direction costs a retry; guessing wrong the other way
 * destroys what the user selected.
 */

/**
 * Verbs that open an instruction about text.
 *
 * Anchored at the start, because "fix the grammar" is an instruction while
 * "I need to fix the grammar" is something the user is dictating. Optional
 * leading politeness, since people say "please shorten this" out loud.
 */
const INSTRUCTION = new RegExp(
  '^(?:please\\s+|can you\\s+|could you\\s+)?' +
  '(?:make|fix|correct|rewrite|rephrase|reword|shorten|lengthen|expand|condense|summari[sz]e|' +
  'simplify|clarify|tighten|polish|proofread|improve|translate|turn|convert|change|replace|' +
  'capitali[sz]e|punctuate|format|bullet|list|sort|reorder|split|join|merge|' +
  'add|remove|delete|strip|cut|trim|drop|' +
  'explain|elaborate|soften|strengthen|formali[sz]e|casuali[sz]e)\\b',
  'i'
);

/**
 * Phrases that name the selection, which make an instruction unmistakable even
 * when it does not start with a verb: "more formal, this bit".
 */
const REFERS_TO_SELECTION = /\b(this|that|it|these|the (?:text|selection|wording|paragraph|sentence|list|above|below))\b/i;

/** Instructions that are only ever instructions, verb or not. */
const BARE_INSTRUCTION = /^(?:more|less|in)\s+\w+/i;

/**
 * Does this sound like an instruction about the selection, or like replacement text?
 *
 * @returns {{instruction: boolean, why: string}}
 */
function classify(spoken, selection) {
  const text = String(spoken || '').trim();
  if (!text) return { instruction: false, why: 'nothing was said' };
  if (!selection) return { instruction: false, why: 'nothing is selected' };

  if (INSTRUCTION.test(text)) {
    // "add a comma after Tuesday" is an instruction; "add milk to the list" said
    // at a shopping list is too. Both are safe: the model is told to return the
    // edited text, so the worst case is an edit the user can undo.
    return { instruction: true, why: 'starts with an instruction verb' };
  }
  if (BARE_INSTRUCTION.test(text) && text.length < 40) {
    return { instruction: true, why: 'a bare instruction such as "more formal"' };
  }
  // A short phrase naming the selection, e.g. "shorter, this one".
  if (text.length < 60 && REFERS_TO_SELECTION.test(text) && /\b(shorter|longer|formal|casual|clearer|simpler|better|concise|brief)\b/i.test(text)) {
    return { instruction: true, why: 'refers to the selection' };
  }
  return { instruction: false, why: 'reads as replacement text' };
}

const SYSTEM_PROMPT =
  'You edit text. The user gives you a passage and an instruction about it.\n' +
  'Reply with the edited passage and nothing else: no preamble, no explanation, ' +
  'no quotation marks around it, no markdown fences.\n' +
  'Keep the original wording wherever the instruction does not ask for a change. ' +
  'Preserve the original language, and keep leading and trailing whitespace as it was.\n' +
  'If the instruction cannot be applied to the passage, reply with the passage unchanged.';

/**
 * Strips the wrapper a small model adds even when told not to.
 *
 * Measured against qwen2.5:1.5b: it reliably obeys "no explanation" but still
 * wraps the answer in quotes or a code fence often enough to matter, and a
 * stray quote pasted into the user's document is a visible defect.
 */
function unwrap(text) {
  let out = String(text || '').trim();
  out = out.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```$/i, '').trim();
  out = out.replace(/^(?:here(?:'s| is) (?:the|your)[^:\n]*:|edited(?: text)?:|result:)\s*/i, '').trim();
  // Only unwrap a quote pair that encloses the whole reply, or an actual quoted
  // passage would lose its quotes.
  const pairs = [['"', '"'], ['“', '”'], ["'", "'"], ['‘', '’']];
  for (const [open, close] of pairs) {
    if (out.length > 1 && out.startsWith(open) && out.endsWith(close) && !out.slice(1, -1).includes(close)) {
      out = out.slice(1, -1).trim();
      break;
    }
  }
  return out;
}

class EditMode {
  constructor({ provider, config, bridge, logger = console } = {}) {
    this.provider = provider;
    this.config = config;
    this.bridge = bridge;
    this.logger = logger;
  }

  /**
   * Applies a spoken instruction to a selection.
   *
   * @param {object} opts
   * @param {string} opts.instruction what the user said
   * @param {string} opts.selection the text they had selected
   * @param {object} [opts.target] the window the selection came from
   * @param {boolean} [opts.insert] false to compute the edit without writing it
   */
  async run({ instruction, selection, target = null, onStage = () => {}, insert = true, signal } = {}) {
    const started = Date.now();
    const original = String(selection || '');
    if (!original.trim()) {
      return { ok: false, reason: 'nothing selected', ms: Date.now() - started };
    }
    if (!this.provider) {
      return { ok: false, reason: 'no model available', ms: Date.now() - started };
    }

    const limit = this.config.get('edit.maxChars', 8000);
    if (original.length > limit) {
      return {
        ok: false,
        reason: `that selection is ${original.length} characters; the limit is ${limit}`,
        ms: Date.now() - started
      };
    }

    onStage('editing');
    const model = this.config.get('llm.editModel') || this.config.get('llm.model');
    const res = await this.provider.chat({
      model,
      temperature: 0,
      signal,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Instruction: ${instruction}\n\nPassage:\n${original}` }
      ]
    });

    const edited = unwrap(res.text);
    if (!edited) {
      return { ok: false, reason: 'the model returned nothing', ms: Date.now() - started };
    }
    if (edited === original) {
      return { ok: true, changed: false, text: original, model, ms: Date.now() - started };
    }

    let inserted = false;
    if (insert) {
      // The selection is still live in the target application, so pasting
      // replaces it. Checked against the window the text came from first:
      // writing into whatever happens to be focused now is how you type into
      // somebody's spreadsheet.
      const safe = await this.sameWindow(target);
      if (!safe.ok) {
        try { await this.bridge.writeClipboard(edited); } catch {}
        return {
          ok: false,
          reason: safe.reason,
          text: edited,
          onClipboard: true,
          model,
          ms: Date.now() - started
        };
      }

      onStage('inserting');
      try {
        await this.bridge.insertText(edited, { mode: 'paste' });
        inserted = true;
      } catch (err) {
        this.logger.error?.(`[edit] insert failed: ${err.message}`);
        try {
          await this.bridge.writeClipboard(edited);
          return { ok: false, reason: err.message, text: edited, onClipboard: true, model, ms: Date.now() - started };
        } catch {}
        return { ok: false, reason: err.message, text: edited, model, ms: Date.now() - started };
      }
    }

    return {
      ok: true,
      changed: true,
      text: edited,
      original,
      inserted,
      instruction,
      target: target && { process: target.process, title: target.title },
      model,
      ms: Date.now() - started
    };
  }

  /** Confirms the window that owned the selection is still the one in front. */
  async sameWindow(target) {
    if (!target || !target.hwnd) return { ok: true };
    let now = null;
    try {
      now = await this.bridge.foregroundWindow();
    } catch (err) {
      return { ok: false, reason: `could not confirm the target window: ${err.message}` };
    }
    if (!now) return { ok: false, reason: 'no window is in front' };
    if (now.hwnd !== target.hwnd) {
      return {
        ok: false,
        reason: `focus moved to ${now.process || now.title || 'another window'}, so the edit was left on the clipboard`
      };
    }
    return { ok: true };
  }
}

module.exports = { EditMode, classify, unwrap, INSTRUCTION };
