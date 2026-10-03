'use strict';
/**
 * A picture, when a picture is the answer.
 *
 * "What does a capybara look like", "who is Ada Lovelace", "where is Machu
 * Picchu" — for these, three sentences of description are a worse answer than
 * one photograph, and the assistant already has the question.
 *
 * Both sources are free and need no key or account:
 *
 *   Wikipedia  authoritative and correctly captioned, and the right answer for
 *              a person, a place, an animal or a landmark. Tried first.
 *   Openverse  Creative Commons search, for everything Wikipedia has no page
 *              for. Broader and less precise, so it is the fallback.
 *
 * The decision of whether to look at all is deliberately conservative. Asking
 * the time, the weather or how many unread emails there are does not want a
 * photograph, and fetching one costs a round trip and a thumbnail nobody
 * wanted. So this looks only when the question is clearly about a thing that
 * can be seen.
 */

const UA = 'VoiceOS/0.1 (local assistant)';

/**
 * Questions that want a picture.
 *
 * "What does X look like" is unambiguous. The rest are the shapes of question
 * that name a seeable thing: a person, a place, a creature, an object.
 */
const WANTS_IMAGE = [
  /\bwhat (?:does|do) (?:a |an |the )?(.+?) look like\b/i,
  /\b(?:show|find) me (?:a |an |some )?(?:pictures?|photos?|images?) of (.+?)[?.!]*$/i,
  /\b(?:picture|photo|image)s? of (.+?)[?.!]*$/i,
  /^who (?:is|was) (.+?)[?.!]*$/i,
  /^where (?:is|was) (.+?)[?.!]*$/i,
  /^what (?:is|was) (?:a |an |the )?(.+?)[?.!]*$/i
];

/** Questions that are about a number or a state, where a photograph is noise. */
const NOT_VISUAL = /\b(?:weather|forecast|temperature|time|date|grade|gpa|email|inbox|calendar|due|homework|unread|playing|volume|password|my )\b/i;

/**
 * What to find a picture of, or null.
 *
 * Returns the subject rather than a yes, because the subject is usually a
 * better search term than the whole question: "who is Ada Lovelace" should
 * look for "Ada Lovelace", not for the question.
 */
function imageSubject(question) {
  const text = String(question || '').trim();
  if (!text || NOT_VISUAL.test(text)) return null;

  for (const re of WANTS_IMAGE) {
    const m = re.exec(text);
    if (!m) continue;
    const subject = m[1].trim().replace(/[?.!]+$/, '');
    // Too short to be a subject, or so long it is a sentence rather than a
    // thing: either way a picture search will not find what was meant.
    if (subject.length < 2 || subject.length > 60) return null;
    // "what is the capital of peru" names a fact, not a thing to look at.
    if (/^(?:the )?(?:capital|population|height|weight|age|price|cost|meaning|definition|difference|point|best|worst)\b/i.test(subject)) return null;
    if (/\b(?:happening|going on|wrong|up)\b/i.test(subject)) return null;
    return subject;
  }
  return null;
}

/**
 * Wikipedia's own summary image.
 *
 * The REST summary endpoint gives a thumbnail and a one-line description for
 * any article, which for a person or a place is both the right picture and
 * correctly captioned.
 */
async function fromWikipedia(subject, { timeoutMs = 6000 } = {}) {
  const search = await fetch(
    'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&list=search&srlimit=1&srsearch=' +
      encodeURIComponent(subject),
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) }
  );
  if (!search.ok) return null;
  const found = await search.json();
  const title = found && found.query && found.query.search && found.query.search[0] && found.query.search[0].title;
  if (!title) return null;

  const res = await fetch(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) }
  );
  if (!res.ok) return null;
  const page = await res.json();
  const thumb = page.thumbnail && page.thumbnail.source;
  if (!thumb) return null;

  return {
    url: thumb,
    width: page.thumbnail.width,
    height: page.thumbnail.height,
    title: page.title,
    caption: page.description || null,
    source: 'Wikipedia',
    link: page.content_urls && page.content_urls.desktop && page.content_urls.desktop.page
  };
}

/** Openverse: Creative Commons images, for anything without an article. */
async function fromOpenverse(subject, { timeoutMs = 6000 } = {}) {
  const res = await fetch(
    'https://api.openverse.org/v1/images/?page_size=1&license_type=all&q=' + encodeURIComponent(subject),
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const hit = (data.results || [])[0];
  if (!hit) return null;
  return {
    url: hit.thumbnail || hit.url,
    title: hit.title || subject,
    caption: hit.creator ? `by ${hit.creator}` : null,
    source: hit.source || 'Openverse',
    link: hit.foreign_landing_url || hit.url
  };
}

/**
 * A picture for this question, or null if it does not want one.
 *
 * Never throws: an answer that arrived without its illustration is still the
 * answer, and a failed image lookup must not take it down.
 */
async function imageFor(question, { logger = console, timeoutMs = 6000 } = {}) {
  const subject = imageSubject(question);
  if (!subject) return null;

  try {
    const wiki = await fromWikipedia(subject, { timeoutMs });
    if (wiki) return wiki;
  } catch (err) {
    logger.debug?.(`[image] wikipedia: ${err.message}`);
  }

  try {
    return await fromOpenverse(subject, { timeoutMs });
  } catch (err) {
    logger.debug?.(`[image] openverse: ${err.message}`);
    return null;
  }
}

/**
 * Downloads the picture and returns it inline.
 *
 * The overlay's content policy allows images from itself and from data URIs
 * and nothing else, which is worth keeping: it means the renderer never makes
 * a request of its own, so nothing on a page the assistant read can cause it
 * to fetch anything. The bytes are collected here instead and handed over
 * whole.
 *
 * Capped, because a thumbnail is tens of kilobytes and anything far larger is
 * not a thumbnail.
 */
async function fetchImageData(image, { maxBytes = 500 * 1024, timeoutMs = 8000 } = {}) {
  if (!image || !image.url) return null;
  const res = await fetch(image.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;

  const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!/^image\//.test(mime)) return null;

  const size = Number(res.headers.get('content-length') || 0);
  if (size && size > maxBytes) return null;

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) return null;

  return { ...image, mime, data: buf.toString('base64'), bytes: buf.length };
}

/** A picture for this question, downloaded and ready to show, or null. */
async function pictureFor(question, opts = {}) {
  const found = await imageFor(question, opts);
  if (!found) return null;
  try {
    return await fetchImageData(found, opts);
  } catch (err) {
    (opts.logger || console).debug?.(`[image] could not download: ${err.message}`);
    return null;
  }
}

module.exports = { imageFor, pictureFor, fetchImageData, imageSubject, fromWikipedia, fromOpenverse };
