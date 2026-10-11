'use strict';
/**
 * Sending the model only the tools the question could possibly need.
 *
 * Every request carried all 34 tool schemas — about 2,266 tokens before the
 * user's words were added. Groq's free tier allows 8,000 tokens a minute, so
 * three questions exhausted it, the fourth got an HTTP 429, and the fallback
 * to the local 1.5B model took longer than the 90-second watchdog. From the
 * outside that looked like the assistant hearing you and never answering,
 * which is exactly what it was.
 *
 * So the list is trimmed to what the words suggest. This is a filter in front
 * of the model, not a decision instead of it: the model still chooses, and
 * anything plausible stays on the list. Being wrong here means the model
 * cannot reach a tool it needed, so the bar for dropping one is high and the
 * floor for how many survive is generous.
 */

/**
 * Tools that stay no matter what was asked.
 *
 * These are the ways out when nothing else fits. Dropping them to save tokens
 * would trade a rate limit for an assistant that cannot answer a general
 * question at all.
 */
const ALWAYS = new Set([
  'answer_from_web', 'search_web', 'do_task', 'personal_data', 'browse', 'news'
]);

/** Pulls the words worth matching on out of a tool's own description. */
function termsFor(tool) {
  const text = `${tool.name} ${tool.description || ''}`.toLowerCase();
  return new Set(
    text
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

/** Words that appear in so many descriptions they separate nothing. */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'use', 'used', 'using',
  'user', 'users', 'get', 'gets', 'set', 'sets', 'one', 'any', 'all', 'about',
  'when', 'what', 'which', 'their', 'them', 'they', 'you', 'your', 'has', 'have',
  'are', 'was', 'were', 'will', 'can', 'may', 'its', 'via', 'into', 'out',
  'tool', 'name', 'named', 'list', 'show', 'current', 'something', 'anything'
]);

/**
 * The tools worth offering for this question.
 *
 * @param {string} question what was asked
 * @param {Array<object>} tools every tool there is
 * @param {object} [opts]
 * @param {number} [opts.max] how many to send at most
 * @returns {Array<object>} a subset, in the original order
 */
function relevantTools(question, tools, { max = 14 } = {}) {
  // Below the cap there is nothing to gain and a mistake to make.
  if (!Array.isArray(tools) || tools.length <= max) return tools;

  const words = new Set(
    String(question || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );

  const scored = tools.map((tool) => {
    if (ALWAYS.has(tool.name)) return { tool, score: Infinity };
    const terms = termsFor(tool);
    let score = 0;
    for (const w of words) {
      if (terms.has(w)) score += 2;
      // A partial match catches "grade" against "grades" without stemming,
      // and counts for less because it is a weaker signal.
      else for (const t of terms) {
        if (t.length > 4 && (t.startsWith(w) || w.startsWith(t))) { score += 1; break; }
      }
    }
    return { tool, score };
  });

  const keep = new Set(
    scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map((s) => s.tool.name)
  );

  // Nothing matched beyond the general-purpose ones. That is not a reason to
  // send all thirty-four: a question whose words match no tool's description
  // — "write me an essay", "what is the square root of five" — is precisely
  // the question the general-purpose tools exist for. Sending only those is
  // both smaller and more accurate than sending everything.
  return tools.filter((t) => keep.has(t.name) || ALWAYS.has(t.name));
}

module.exports = { relevantTools, ALWAYS };
