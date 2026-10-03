'use strict';
/**
 * Doing a thing on a website, step by step.
 *
 * Look at the page, choose one action, do it, look again. The loop is the easy
 * part; what makes it work or not is what the model is shown and what it is
 * allowed to say back.
 *
 * It is shown a numbered list of what can be acted on (see page-map) rather
 * than a screenshot, so there are no coordinates to guess and no vision model
 * to pay for. It answers with one line naming one action, because a small
 * model asked for JSON produces almost-JSON, and a parser that accepts
 * almost-anything is more use than one that rejects it.
 *
 * Two things it is not allowed to do on its own:
 *
 *   Type into a password field. Enforced in the page map, which never offers
 *   one, and again here.
 *
 *   Press anything that sends, buys, deletes or submits. Those are asked
 *   about first, because the cost of being wrong is not symmetrical: a wrong
 *   click on a link costs a page load, and a wrong click on "Submit" costs an
 *   assignment turned in half-finished.
 */
const { mapPage, describe, CLICK_REF, TYPE_REF, parse } = require('./page-map');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Words too common to be evidence of anything. */
const COMMON = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'is', 'are', 'was', 'were',
  'it', 'its', 'that', 'this', 'for', 'from', 'with', 'by', 'as', 'be', 'been', 'has', 'have',
  'found', 'about', 'page', 'website', 'site', 'wikipedia', 'google', 'they', 'their', 'there',
  'you', 'your', 'i', 'we', 'can', 'will', 'would', 'should', 'belong', 'belongs', 'according'
]);

/**
 * Is this answer actually supported by what was read?
 *
 * Takes the distinctive words of the answer and looks for them in the page
 * text. Deliberately crude: it is not checking that the answer is correct,
 * only that it came from somewhere rather than from the model's memory. A
 * model reporting a true fact it never looked up is still reporting something
 * it cannot stand behind, and that is what this catches.
 *
 * Numbers count double, because a figure appearing in both places is much
 * stronger evidence than a word doing so.
 */
function groundedIn(answer, pageText) {
  const text = String(pageText || '').toLowerCase();
  if (!text) return { grounded: false, score: 0, checked: 0 };

  const tokens = String(answer || '')
    .toLowerCase()
    .replace(/[^a-z0-9.\s-]/g, ' ')
    .split(/\s+/)
    // Numbers are kept however short: "35" is the whole point, and the length
    // rule was quietly discarding exactly the evidence worth having.
    .filter((w) => (w.length > 3 || /^\d+(\.\d+)?$/.test(w)) && !COMMON.has(w));

  const distinctive = [...new Set(tokens)];
  if (!distinctive.length) return { grounded: false, score: 0, checked: 0 };

  // Pages paraphrase: "weighs" against "weigh", "kilograms" against "kg". A
  // prefix is enough, since the question is whether the answer came from here
  // at all, not whether it was quoted.
  const present = (w) => {
    if (text.includes(w)) return true;
    if (/^\d/.test(w)) return false;
    return w.length > 5 && text.includes(w.slice(0, Math.max(5, w.length - 2)));
  };

  let hits = 0;
  let weight = 0;
  for (const w of distinctive) {
    const isNumber = /\d/.test(w);
    weight += isNumber ? 2 : 1;
    if (present(w)) hits += isNumber ? 2 : 1;
  }

  const score = weight ? hits / weight : 0;
  // Half is a low bar on purpose. The failure being caught is an answer with
  // no connection to the page — "otters belong to Mustelidae" reported from a
  // page about a singer — not an imperfect paraphrase.
  return { grounded: score >= 0.5, score, checked: distinctive.length };
}

/**
 * Works through a task on a page.
 *
 * @param {object} opts
 * @param {string} opts.task what to do, in the user's words
 * @param {string} [opts.startUrl] where to begin
 * @param {(prompt: object) => Promise<boolean>} [opts.confirm] asked before
 *   anything irreversible; without it, those are refused rather than assumed
 * @param {(step: object) => void} [opts.onStep] progress, for the overlay
 */
/**
 * Labels that mean "this is hard to undo".
 *
 * The cost of being wrong is not symmetrical: a wrong click on a link costs a
 * page load, and a wrong click on "Submit" costs an assignment handed in
 * half-finished. These are asked about first.
 */
const IRREVERSIBLE = /\b(submit|send|pay|buy|purchase|order|checkout|delete|remove|confirm|publish|post|turn in|hand in|finish attempt|apply|book|cancel)\b/i;

const SYSTEM = [
  'You operate a web browser to finish a task.',
  'You are shown the page and a numbered list of things you can do on it.',
  'Reply with ONE line, nothing else. One of:',
  '  CLICK <number>',
  '  TYPE <number> <text>',
  '  SCROLL',
  '  GO <url>',
  '  DONE <what you found or did>',
  'Only answer DONE with something that is actually written on the page.',
  'Never invent a number that is not in the list.'
].join('\n');

/**
 * Parses one line of model output into an action, leniently.
 *
 * A small model asked for JSON produces almost-JSON, so this accepts the shape
 * rather than demanding it: stray bullets, brackets round the number, quotes
 * round the text.
 */
function parseAction(text) {
  const line = String(text || '').trim().split('\n').find((l) => l.trim()) || '';
  const t = line.replace(/^[-*\d.\s]+/, '').trim();

  let m = /^CLICK\s+\[?(\d+)\]?/i.exec(t);
  if (m) return { kind: 'click', n: Number(m[1]) };

  m = /^TYPE\s+\[?(\d+)\]?\s+(.+)$/i.exec(t);
  if (m) return { kind: 'type', n: Number(m[1]), text: m[2].replace(/^["']|["']$/g, '') };

  m = /^GO\s+(\S+)/i.exec(t);
  if (m) return { kind: 'go', url: m[1] };

  if (/^SCROLL/i.test(t)) return { kind: 'scroll' };

  m = /^DONE\b[:\s]*(.*)$/i.exec(t);
  if (m) return { kind: 'done', answer: m[1].trim() };

  // Drifted into prose, which usually contains the answer. Taken as one, but
  // it still has to survive the grounding check like any other.
  if (t.length > 12) return { kind: 'done', answer: t.slice(0, 300), drifted: true };
  return { kind: 'unknown', raw: t };
}

async function browseAndDo({
  task, browser, provider, model, startUrl = null,
  maxSteps = 10, confirm = null, onStep = () => {}, logger = console, signal = null
} = {}) {
  if (!task) return { ok: false, reason: 'no task given' };
  if (!provider) return { ok: false, reason: 'no model available to decide what to do' };

  await browser.launch();
  const first = startUrl || 'https://www.google.com';
  const { page } = await browser.openOrReuse(first, new URL(first).hostname);
  if (startUrl) await page.navigate(startUrl);

  const history = [];
  const visited = [];

  for (let step = 1; step <= maxSteps; step++) {
    if (signal && signal.aborted) return { ok: false, reason: 'cancelled', history };

    const map = await mapPage(page);
    visited.push(map.url);
    onStep({ step, url: map.url, title: map.title });

    // Deliberately short. Every token is paid for on every step, and a model
    // given the whole page reads none of it.
    const prompt = [
      `TASK: ${task}`,
      history.length ? `\nSO FAR:\n${history.slice(-4).map((h) => '  ' + h).join('\n')}` : '',
      '',
      describe(map, { maxItems: 35, maxText: 900 }),
      '',
      `Step ${step} of ${maxSteps}. One line.`
    ].filter(Boolean).join('\n');

    let reply;
    try {
      const res = await provider.chat({
        model,
        temperature: 0,
        maxTokens: 60,
        signal,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }]
      });
      reply = res.text;
    } catch (err) {
      return { ok: false, reason: `the model failed: ${err.message}`, history };
    }

    const action = parseAction(reply);
    logger.info?.(`[browse] step ${step}: ${action.kind}${action.n != null ? ' ' + action.n : ''}`);

    if (action.kind === 'done') {
      // Checked against what was actually read, because a model that answers
      // from memory and calls it a finding is the worst thing this can do.
      const ground = groundedIn(action.answer, `${map.text} ${map.title}`);
      if (ground.grounded || !action.answer) {
        return { ok: true, answer: action.answer, steps: step, history, url: map.url, visited };
      }

      logger.warn?.(`[browse] "${String(action.answer).slice(0, 60)}" is not on this page (${Math.round(ground.score * 100)}% matched)`);
      history.push(`step ${step}: claimed an answer that is not on this page`);

      // One more look before giving up: it may simply be on the wrong page,
      // and saying so beats repeating something it cannot support.
      if (step >= maxSteps - 1) {
        return {
          ok: false,
          unverified: action.answer,
          reason: 'I could not find that on the page — it may have been remembered rather than read.',
          steps: step, history, url: map.url, visited
        };
      }
      continue;
    }

    if (action.kind === 'unknown') {
      history.push(`step ${step}: did not understand "${action.raw}"`);
      continue;
    }

    if (action.kind === 'scroll') {
      await page.evaluate('window.scrollBy(0, Math.round(window.innerHeight * 0.85))');
      history.push(`step ${step}: scrolled`);
      await sleep(400);
      continue;
    }

    if (action.kind === 'go') {
      const url = /^https?:\/\//i.test(action.url) ? action.url : `https://${action.url}`;
      await page.navigate(url).catch(() => {});
      history.push(`step ${step}: went to ${url}`);
      await sleep(700);
      continue;
    }

    const target = (map.items || []).find((i) => i.n === action.n);
    if (!target) {
      history.push(`step ${step}: there is no [${action.n}] on this page`);
      continue;
    }

    if (action.kind === 'type') {
      const r = parse(await page.evaluate(TYPE_REF(action.n, action.text)));
      history.push(r.ok
        ? `step ${step}: typed "${action.text.slice(0, 40)}" into ${target.text || 'a field'}`
        : `step ${step}: could not type — ${r.reason}`);
      await sleep(300);
      continue;
    }

    if (action.kind === 'click') {
      // The asymmetry: a wrong link costs a page load, a wrong "Submit" costs
      // an assignment handed in half-finished.
      if (IRREVERSIBLE.test(target.text || '')) {
        const prompt_ = {
          title: `Press "${target.text}"?`,
          detail: `On ${map.title || map.url}\n\nTask: ${task}`,
          app: 'Browser'
        };
        const approved = confirm ? await confirm(prompt_) : false;
        if (!approved) {
          return {
            ok: false,
            needsApproval: true,
            reason: `Stopped before pressing "${target.text}".`,
            history, url: map.url
          };
        }
      }

      const r = parse(await page.evaluate(CLICK_REF(action.n)));
      history.push(r.ok ? `step ${step}: clicked ${r.clicked || target.text}` : `step ${step}: ${r.reason}`);
      // Let whatever it triggered settle before looking again.
      await sleep(900);
      continue;
    }
  }

  const map = await mapPage(page);
  return {
    ok: false,
    reason: `ran out of steps after ${maxSteps}`,
    history,
    url: map.url
  };
}

module.exports = { browseAndDo, parseAction, groundedIn, IRREVERSIBLE };
