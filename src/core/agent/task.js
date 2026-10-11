'use strict';
/**
 * Doing a piece of work, rather than talking about it.
 *
 * Modelled on how Cowork works: you describe an outcome, it plans, it steps
 * out to the web to *read* rather than recall, and it comes back with
 * something finished.
 *
 * The one rule that runs through all of it, and the reason this file is shaped
 * the way it is: what was read and what was written are never confused. An
 * answer found on the page is reported as found, with the page it came from.
 * An answer the model produced is reported as written, and says so. The
 * failure this guards against has already happened twice in this project —
 * grades answered out of the wrong system, and an otter fact recited from
 * memory while claiming to have looked it up. Both read as confident and
 * correct, which is what made them bad.
 *
 * So every result carries where it came from, and the user is told.
 */
const fs = require('fs');
const path = require('path');
const { mapPage } = require('../browser/page-map');
const { browseAndDo } = require('../browser/agent');
const { answerFromWeb } = require('./web');

/** Where work is left, so there is somewhere to come back to. */
function workDir(config) {
  const configured = config.get('tasks.folder', null);
  if (configured) return configured;
  return path.join(require('os').homedir(), 'Documents', 'VoiceOS');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is this a question to answer, or a piece of work to produce?
 *
 * A question has an answer somewhere and should be looked up. Work does not —
 * searching for "write a paragraph about X" finds advice about writing
 * paragraphs, which is not the paragraph, and reporting it as though it were
 * the answer is worse than saying nothing.
 */
function isProduction(goal) {
  const t = String(goal || '').trim();
  // Imperatives that name something to be made.
  if (/^(?:please\s+)?(?:write|draft|compose|make|create|generate|produce|build|design|rewrite|reword|summari[sz]e|paraphrase|outline|plan|solve|work out|do)\b/i.test(t)) return true;
  // "answer these questions", "finish my essay", "complete the worksheet".
  if (/\b(?:answer|finish|complete|fill in|do)\b[^?]{0,30}\b(?:questions?|essay|assignment|homework|worksheet|problems?|quiz)\b/i.test(t)) return true;
  // "explain X" sits on the line; if it asks for a paragraph or an essay it is
  // work, and otherwise it is a question with a real answer.
  if (/^(?:explain|describe)\b/i.test(t) && /\b(paragraph|essay|page|words|sentences)\b/i.test(t)) return true;
  return false;
}

/** How the console recognises the label, to show it as a note. */
const WRITTEN_NOTE = '(Written by me, not looked up — check anything that matters.)';

/** The shape of a finished piece of work. */
function report({ goal, found = [], written = null, file = null, steps = [], sources = [] }) {
  const lines = [];
  if (found.length) {
    lines.push('FOUND', ...found.map((f) => `  ${f}`));
  }
  if (written) {
    // Labelled, always. This is the sentence that stops a generated answer
    // being mistaken for a researched one. After the text rather than in
    // capitals before it: the label is a footnote, and leading with it made
    // every answer — a poem included — open with a warning.
    lines.push('', written, '', WRITTEN_NOTE);
  }
  if (file) lines.push('', `Saved to ${file}`);
  if (sources.length) lines.push('', 'SOURCES', ...sources.map((s) => `  ${s}`));

  return {
    ok: true,
    goal,
    summary: lines.join('\n').trim() || 'Nothing to report.',
    found,
    written,
    file,
    steps,
    sources
  };
}

/**
 * Reads a page and tries to answer from it.
 *
 * Returns null rather than a guess when the page does not say: a null here
 * becomes "I wrote this myself", which is a different and honest answer.
 */
async function answerFromPage({ page, question, provider, model, logger, signal }) {
  const map = await mapPage(page);
  const text = (map.text || '').slice(0, 2400);
  if (!text || !provider) return null;

  const res = await provider.chat({
    model,
    temperature: 0,
    maxTokens: 160,
    signal,
    messages: [
      {
        role: 'system',
        content: [
          'Answer the question using only the page below.',
          'If the page does not contain the answer, reply with exactly: NOT ON PAGE',
          'Otherwise answer in one or two sentences, quoting the page where you can.'
        ].join('\n')
      },
      { role: 'user', content: `QUESTION: ${question}\n\nPAGE (${map.title}):\n${text}` }
    ]
  }).catch((err) => {
    logger.debug?.(`[task] page answer failed: ${err.message}`);
    return null;
  });

  const answer = String((res && res.text) || '').trim();
  if (!answer || /NOT ON PAGE/i.test(answer)) return null;

  // The same grounding rule as the browser agent: the words have to be there.
  const words = answer.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 4);
  const hits = words.filter((w) => text.toLowerCase().includes(w)).length;
  if (words.length && hits / words.length < 0.4) {
    logger.debug?.('[task] the page answer was not actually on the page');
    return null;
  }

  return { answer, url: map.url, title: map.title };
}

/** Writes the answer itself, when nothing could be found. */
async function writeAnswer({ goal, context, provider, model, signal, logger }) {
  if (!provider) return null;
  const res = await provider.chat({
    model,
    temperature: 0.3,
    maxTokens: 500,
    signal,
    messages: [
      {
        role: 'system',
        content: [
          'You are doing a piece of work for a student.',
          'Produce the actual thing asked for — the answer, the paragraph, the explanation.',
          'No preamble, no "here is", no offer to help further. Just the work.'
        ].join('\n')
      },
      { role: 'user', content: context ? `${goal}\n\nWhat I could find:\n${context}` : goal }
    ]
  }).catch((err) => {
    logger.debug?.(`[task] could not write it: ${err.message}`);
    return null;
  });

  const text = String((res && res.text) || '').trim();
  return text || null;
}

/**
 * Takes a goal and finishes it.
 *
 * @param {object} opts
 * @param {string} opts.goal in the user's own words
 * @param {string} [opts.url] a page to work from, if there is one
 * @param {boolean} [opts.save] write the result to a file
 * @param {(step: string) => void} [opts.onProgress]
 */
async function runTask({
  goal, url = null, save = true,
  browser, provider, model, config, logger = console, signal = null,
  confirm = null, onProgress = () => {}, maxSteps = 8
} = {}) {
  if (!goal) return { ok: false, summary: 'No task given.' };

  const steps = [];
  const sources = [];
  const found = [];
  const note = (s) => { steps.push(s); onProgress(s); logger.info?.(`[task] ${s}`); };

  const production = isProduction(goal);
  let pageText = null;

  // 1. If there is a page, read it — as the answer if this is a question, and
  //    as the material to work from if it is a piece of work. Reading beats
  //    recalling either way.
  if (url && browser) {
    note(`opening ${url}`);
    await browser.launch();
    const { page } = await browser.openOrReuse(url, new URL(url).hostname);
    await page.navigate(url).catch(() => {});
    await sleep(600);

    const map = await mapPage(page).catch(() => null);
    if (map && map.text) {
      pageText = map.text.slice(0, 2400);
      sources.push(`${map.title || 'page'} — ${map.url}`);
    }

    if (!production) {
      const pageAnswer = await answerFromPage({ page, question: goal, provider, model, logger, signal });
      if (pageAnswer) {
        note('found it on the page');
        found.push(pageAnswer.answer);
      } else {
        note('the page does not answer it');
      }
    } else {
      note('read the page to work from');
    }
  }

  // 2. A question gets looked up. Work does not: searching for "write a
  //    paragraph about X" finds advice about writing paragraphs, and
  //    reporting that as the answer is worse than saying nothing.
  if (!production && !found.length && provider) {
    note('searching');
    const web = await answerFromWeb({ query: goal, provider, model, logger, signal }).catch(() => null);
    if (web && web.ok && web.summary && !/could not find/i.test(web.summary)) {
      found.push(web.summary);
      for (const s of web.found || []) sources.push(`${s.title} — ${s.url || s.subtitle}`);
      note('found it on the web');
    } else {
      note('the web does not answer it either');
    }
  }

  // 3. Produce it. Labelled as written, never as found.
  let written = null;
  if (!found.length) {
    note(production ? 'writing it' : 'nothing found, so writing it myself');
    written = await writeAnswer({ goal, context: pageText, provider, model, signal, logger });
    if (!written) {
      return {
        ok: false,
        goal,
        summary: 'I could not find this and could not write it either — the model is unavailable.',
        steps
      };
    }
  }

  // 4. Leave it somewhere, so there is something to come back to.
  let file = null;
  if (save && (found.length || written)) {
    try {
      const dir = workDir(config);
      fs.mkdirSync(dir, { recursive: true });
      const safe = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      file = path.join(dir, `${safe || 'task'}-${new Date().toISOString().slice(0, 10)}.md`);

      const body = [
        `# ${goal}`,
        '',
        found.length ? '## Found' : '',
        ...found,
        written ? '\n## Written by me — not found anywhere, check it' : '',
        written || '',
        sources.length ? `\n## Sources\n${sources.map((s) => `- ${s}`).join('\n')}` : '',
        `\n---\n${new Date().toLocaleString()}`
      ].filter(Boolean).join('\n');

      fs.writeFileSync(file, body);
      note(`saved to ${path.basename(file)}`);
    } catch (err) {
      logger.warn?.(`[task] could not save: ${err.message}`);
      file = null;
    }
  }

  return report({ goal, found, written, file, steps, sources });
}

module.exports = { runTask, isProduction, answerFromPage, writeAnswer, workDir };
