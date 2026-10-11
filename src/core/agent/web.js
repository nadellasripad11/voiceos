'use strict';
/**
 * Answering from the web, rather than handing over a list of links.
 *
 * The old behaviour returned search results, so asking about a stock price got
 * "Here are a few links:" followed by three URLs read aloud. Nobody asks a
 * voice assistant a question hoping to be given homework. This reads the top
 * results and answers the question from them.
 *
 * Weather is handled separately and without a model at all. It is one of the
 * most common things anyone asks, the answer is a number, and a 1.5B model
 * asked to summarise a search page will cheerfully invent one — or, as it did
 * here, reply "I'm sorry, but I can't access the internet". Open-Meteo gives
 * the real forecast for free with no key and no account, so the assistant
 * states a measured fact instead of guessing.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

/** How much of one page is worth reading, and how much context in total. */
const PAGE_CHARS = 1200;
const SNIPPET_CHARS = 1400;

// --- Weather ---------------------------------------------------------------

/** WMO weather codes, which is what Open-Meteo reports. */
const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'a thunderstorm', 96: 'a thunderstorm with hail', 99: 'a thunderstorm with hail'
};

const describeCode = (code) => WMO[code] || 'unsettled';

/** Where the user is, from their IP. Free, no key, no account. */
async function locateByIp({ timeoutMs = 6000 } = {}) {
  const res = await fetch('http://ip-api.com/json/?fields=status,city,regionName,country,lat,lon,timezone', {
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`location lookup returned HTTP ${res.status}`);
  const d = await res.json();
  if (d.status !== 'success') throw new Error('location lookup failed');
  return { name: d.city, region: d.regionName, country: d.country, lat: d.lat, lon: d.lon, timezone: d.timezone };
}

/** Turns a place name into coordinates. Also free and keyless. */
async function geocode(place, { timeoutMs = 6000 } = {}) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=' +
    encodeURIComponent(place);
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`geocoding returned HTTP ${res.status}`);
  const d = await res.json();
  const hit = (d.results || [])[0];
  if (!hit) return null;
  return {
    name: hit.name, region: hit.admin1, country: hit.country,
    lat: hit.latitude, lon: hit.longitude, timezone: hit.timezone
  };
}

const round = (n) => (n == null ? null : Math.round(n));

/**
 * The actual forecast.
 *
 * @param {object} opts
 * @param {string} [opts.place] a named place; the user's own location otherwise
 * @param {'today'|'tomorrow'|'now'} [opts.when]
 * @param {'F'|'C'} [opts.units]
 */
async function getWeather({ place = null, when = 'now', units = 'F', timeoutMs = 8000 } = {}) {
  // A named place that no gazetteer knows — a local park, a school, a
  // mishearing — is not a reason to refuse. The weather where the user is
  // standing is almost certainly what they wanted, so it falls back and says
  // which place it answered for.
  let where = place ? await geocode(place).catch(() => null) : null;
  let fellBackToHere = false;
  if (!where) {
    where = await locateByIp();
    fellBackToHere = Boolean(place);
  }
  if (!where) return { ok: false, summary: 'I could not work out where you are.' };

  const unit = units === 'C' ? 'celsius' : 'fahrenheit';
  const symbol = units === 'C' ? '°C' : '°F';
  const url = 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${where.lat}&longitude=${where.lon}` +
    '&current=temperature_2m,apparent_temperature,weather_code' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max' +
    `&timezone=auto&forecast_days=3&temperature_unit=${unit}&wind_speed_unit=mph`;

  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`weather service returned HTTP ${res.status}`);
  const d = await res.json();

  const place_ = [where.name, where.region].filter(Boolean).join(', ');

  // When the place asked for could not be found, the answer is for somewhere
  // else and has to say so. Only the spoken line admitted it before, so anyone
  // reading the screen saw "Marietta, Georgia: 69F" after asking about a park
  // twenty miles away, with nothing to suggest it was not the answer.
  const notFound = fellBackToHere ? `I could not find "${place}", so this is where you are.\n` : '';
  const daily = d.daily || {};
  const dayIndex = when === 'tomorrow' ? 1 : 0;

  if (when === 'now') {
    const c = d.current || {};
    const sky = describeCode(c.weather_code);
    const feels = round(c.apparent_temperature);
    const temp = round(c.temperature_2m);
    // The spoken line carries no symbol; it is read out, not displayed.
    const feelsSpoken = feels != null && Math.abs(feels - temp) >= 3 ? `, feels like ${feels}` : '';
    const feelsShown = feels != null && Math.abs(feels - temp) >= 3 ? `, feels like ${feels}${symbol}` : '';
    const high = round(daily.temperature_2m_max && daily.temperature_2m_max[0]);
    const low = round(daily.temperature_2m_min && daily.temperature_2m_min[0]);
    const rain = daily.precipitation_probability_max && daily.precipitation_probability_max[0];

    return {
      ok: true,
      place: place_,
      // Short on purpose: the place is where the user is standing, and the
      // detail is on screen. Only the fallback names the place, because then
      // it is not the one that was asked for.
      spoken: (fellBackToHere ? `I could not find ${place}. In ${where.name}, ` : '') +
        // Named only when it was asked for, for the same reason as above.
        `${place && !fellBackToHere ? `In ${where.name}, ` : ''}${temp} and ${sky}. High ${high}, low ${low}.`,
      summary: notFound + `${place_}: ${temp}${symbol}, ${sky}${feelsShown}.\n` +
        `Today: high ${high}${symbol}, low ${low}${symbol}` +
        (rain != null ? `, ${rain}% chance of rain.` : '.'),
      found: [{
        glyph: '🌤️',
        title: `${temp}${symbol} — ${sky}`,
        subtitle: `${place_} · high ${high}${symbol} · low ${low}${symbol}` +
          (rain != null ? ` · ${rain}% rain` : '')
      }]
    };
  }

  const high = round(daily.temperature_2m_max && daily.temperature_2m_max[dayIndex]);
  const low = round(daily.temperature_2m_min && daily.temperature_2m_min[dayIndex]);
  const sky = describeCode(daily.weather_code && daily.weather_code[dayIndex]);
  const rain = daily.precipitation_probability_max && daily.precipitation_probability_max[dayIndex];
  const label = when === 'tomorrow' ? 'Tomorrow' : 'Today';

  return {
    ok: true,
    place: place_,
    spoken: (fellBackToHere ? `I could not find ${place}. In ${where.name}, ` : '') +
      // The place is named only when it was asked for. Saying "in Marietta"
      // every time is wasted speech when that is simply where you are, but
      // leaving it off a named place answers a question nobody asked.
      `${label}${place && !fellBackToHere ? ` in ${where.name}` : ''}: ${sky}, high ${high}, low ${low}` +
      (rain != null && rain >= 50 ? `, ${rain} percent rain.` : '.'),
    summary: notFound + `${place_} — ${label.toLowerCase()}: ${sky}, high ${high}${symbol}, low ${low}${symbol}` +
      (rain != null ? `, ${rain}% chance of rain.` : '.'),
    found: [{
      glyph: '🌤️',
      title: `${label}: ${sky}`,
      subtitle: `${place_} · high ${high}${symbol} · low ${low}${symbol}` +
        (rain != null ? ` · ${rain}% rain` : '')
    }]
  };
}

// --- Reading the web -------------------------------------------------------

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    // Hex entities are at least as common as decimal ones: DuckDuckGo returns
    // &#x27; for an apostrophe, which was being read out as literal text.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeDdgUrl(href) {
  const m = /uddg=([^&]+)/.exec(href);
  return m ? decodeURIComponent(m[1]) : href;
}

/**
 * Searching, with somewhere to go when the first engine says no.
 *
 * DuckDuckGo's HTML page is free and needs no key, but it throttles: three
 * searches in a row returned 8, 8 and then 0 results (a 202 challenge page),
 * and in the app it failed outright — so "summarize world news" answered
 * that the search did not come back. Behind it now: Wikipedia's search API
 * for facts and Google News for anything current, both free, keyless and
 * structured. Bing was tried and rejected: it answered "james webb telescope"
 * with a Bible verse, and a confident wrong source is worse than none.
 */
let ddgCoolUntil = 0;

async function search(query, { timeoutMs = 8000 } = {}) {
  if (Date.now() >= ddgCoolUntil) {
    try {
      const results = await duckDuckGoHtml(query, timeoutMs);
      if (results.length) return results;
    } catch { /* falls through to the others */ }
    // Throttled or unreachable: skip it for a while rather than paying its
    // timeout on every question.
    ddgCoolUntil = Date.now() + 2 * 60000;
  }

  const timely = /\b(?:news|latest|today|tonight|yesterday|this week|recent(?:ly)?|current(?:ly)?|right now|score|election|update)\b/i.test(query);
  const [wiki, news] = await Promise.all([
    searchWikipedia(query).catch(() => []),
    timely ? newsHeadlines(query, { limit: 5 }).catch(() => []) : Promise.resolve([])
  ]);
  const fromNews = news.map((n) => ({ url: n.url, title: n.title, snippet: [n.source, n.when].filter(Boolean).join(', ') }));
  return timely ? [...fromNews, ...wiki] : [...wiki, ...fromNews];
}

/** DuckDuckGo's HTML endpoint: no API key, no quota, no cost. */
async function duckDuckGoHtml(query, timeoutMs) {
  const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) return [];
  const html = await res.text();
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    const url = decodeDdgUrl(m[1]);
    out.push({ url, title: stripHtml(m[2]), snippet: stripHtml(m[3]) });
  }
  return out;
}

/** Wikipedia's search: titles and a snippet each; the page is read if a snippet is too thin. */
async function searchWikipedia(query, { limit = 4, timeoutMs = 6000 } = {}) {
  const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1' +
    `&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    // Wikipedia asks API clients to say who they are.
    headers: { 'User-Agent': 'VoiceOS/0.1 (personal voice assistant)' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) return [];
  const data = await res.json();
  return ((data.query && data.query.search) || []).map((s) => ({
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`,
    title: `${s.title} — Wikipedia`,
    snippet: stripHtml(s.snippet)
  }));
}

/**
 * Headlines from Google News's RSS feed: top stories, or a topic search.
 * Free, keyless, current, and arriving as structured items rather than a page
 * to scrape. Each title comes as "Headline - Source"; the source is split off.
 *
 * @returns {Promise<Array<{title: string, source: string, url: string, when: string}>>}
 */
async function newsHeadlines(topic = '', { limit = 8, timeoutMs = 8000 } = {}) {
  const base = 'https://news.google.com/rss';
  const tail = 'hl=en-US&gl=US&ceid=US:en';
  const url = topic ? `${base}/search?q=${encodeURIComponent(topic)}&${tail}` : `${base}?${tail}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return [];
  const xml = await res.text();
  const field = (item, name) => {
    const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
    return m ? stripHtml(m[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : '';
  };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit).map(([, item]) => {
    const source = field(item, 'source');
    let title = field(item, 'title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const published = Date.parse(field(item, 'pubDate'));
    return { title, source, url: field(item, 'link'), when: published ? ago(published) : '' };
  }).filter((n) => n.title);
}

/** "3 hours ago", for a headline's age. */
function ago(at) {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 60) return `${mins || 1} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} hour${hours === 1 ? '' : 's'} ago` : `${Math.round(hours / 24)} days ago`;
}

/** Fetches one page and returns its readable text, or null. */
async function readPage(url, { timeoutMs = 9000, maxChars = 4000 } = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!/text\/html|text\/plain/i.test(type)) return null;
    const text = stripHtml(await res.text());
    if (text.length < 120) return null;
    return text.slice(0, maxChars);
  } catch {
    return null;
  }
}

/**
 * Kept to one line on purpose.
 *
 * Prompt evaluation is the whole cost on a local model — measured here at
 * roughly 50 tokens a second — so every sentence of instruction is paid for on
 * every question. A seven-line prompt plus two full pages took 33 seconds; one
 * line plus the search snippets takes about eight and answers just as well.
 */
const ANSWER_PROMPT =
  'Answer the question using the text below. One or two short sentences, as you would say them aloud. ' +
  'Give the actual number, name or date. No preamble, no markdown, no links. ' +
  'The text was just fetched for you, so never say you cannot access the internet.';

/**
 * Searches and answers the question from what it finds.
 *
 * Search snippets alone are not an answer — "Lima - Wikipedia" is not a reply
 * to "what is the capital of Peru" — so they are handed to the model to turn
 * into one. A page is only fetched when the snippets look too thin to carry
 * the answer, because fetching and feeding full pages was what made this take
 * most of a minute.
 */
async function answerFromWeb({ query, provider, model, logger = console, signal }) {
  // The instant answer is free and needs no model at all, so it is worth the
  // one request before anything else.
  const [instant, results] = await Promise.all([
    instantAnswer(query).catch(() => null),
    search(query).catch(() => [])
  ]);

  const sources = results.slice(0, 3).map((r) => ({
    glyph: '🔍',
    title: r.title,
    subtitle: hostOf(r.url),
    url: r.url
  }));

  if (instant && instant.length > 40) {
    const text = firstSentences(instant, 2);
    return { ok: true, summary: text, spoken: text, found: sources };
  }

  if (!results.length) {
    // miss, not an answer. The router picked this tool from the wording of the
    // question, and finding nothing usually means it picked wrong rather than
    // that the web is empty — so the agent gets to try the model instead of
    // reading "I could not find anything" out as though it were the result.
    return {
      ok: true,
      miss: true,
      summary: `I could not find anything for "${query}".`,
      spoken: 'I could not find anything on that.'
    };
  }

  let context = results.slice(0, 4)
    .map((r) => `${r.title}: ${r.snippet}`)
    .join('\n')
    .slice(0, SNIPPET_CHARS);

  // Thin snippets cannot carry an answer, so in that case — and only then — one
  // page is read.
  if (context.length < 320) {
    const page = await readPage(results[0].url, { maxChars: PAGE_CHARS });
    if (page) context = (context + '\n' + page).slice(0, SNIPPET_CHARS + PAGE_CHARS);
  }

  if (!provider) {
    const snippet = results.map((r) => r.snippet).find(Boolean);
    return { ok: true, summary: snippet || results[0].title, spoken: snippet || results[0].title, found: sources };
  }

  try {
    const res = await provider.chat({
      model,
      temperature: 0,
      // Capped so it answers rather than essays; it is going to be read aloud.
      maxTokens: 120,
      signal,
      messages: [
        { role: 'system', content: ANSWER_PROMPT },
        { role: 'user', content: `Question: ${query}

${context}` }
      ]
    });
    const answer = cleanAnswer(res.text);
    if (answer) return { ok: true, summary: answer, spoken: answer, found: sources };
  } catch (err) {
    logger.warn?.(`[web] could not summarise: ${err.message}`);
  }

  const snippet = results.map((r) => r.snippet).find(Boolean);
  return { ok: true, summary: snippet || results[0].title, spoken: snippet || results[0].title, found: sources };
}

/** DuckDuckGo's Instant Answer API: a real answer for definitions and people. */
async function instantAnswer(query, { timeoutMs = 7000 } = {}) {
  const res = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    { signal: AbortSignal.timeout(timeoutMs) }
  );
  if (!res.ok) return null;
  const d = await res.json();
  return d.AbstractText || d.Answer || null;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** The first n sentences, so an encyclopaedia paragraph is not read out whole. */
function firstSentences(text, n) {
  const parts = String(text).split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, n).join(' ').trim();
}

/**
 * Strips the hedging and markup a small model adds.
 *
 * "I'm sorry, but I can't access the internet" is the specific failure this
 * guards: the model has the page text in front of it and still claims it
 * cannot look anything up, so that reply is discarded rather than spoken.
 */
function cleanAnswer(text) {
  let out = String(text || '').trim();
  if (!out) return '';
  // The model has the page text in front of it, so a refusal to "access the
  // internet" is a hallucinated apology rather than an answer: it is discarded
  // and the caller falls back to the search snippet. Both halves have to match,
  // so a genuine answer that happens to mention the internet is not thrown away.
  const apologises = /^(?:i'?m sorry|i am sorry|sorry|unfortunately|as an ai|i'?m an ai|i (?:can|could|do|am|don'?t|cannot))\b/i.test(out);
  const disclaims = /\b(?:cannot|can ?not|can'?t|couldn'?t|don'?t have|do not have|unable to|no)\b[^.]{0,60}\b(?:access|browse|connect|retrieve|look up|real[- ]time|up[- ]to[- ]date|internet|live data|current (?:data|information))\b/i.test(out);
  if (apologises && disclaims) return '';

  out = out
    .replace(/^\u0060\u0060\u0060[a-z]*\s*/i, '')
    .replace(/\u0060\u0060\u0060$/i, '')
    // A markdown link reads as its text; the URL is noise aloud and on screen.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:here(?:'s| is)[^:\n]{0,40}:|answer:)\s*/i, '')
    .replace(/^\s*(?:based on|according to)[^,.]*[,.]\s*/i, '')
    .replace(/\b(?:can be found |as (?:stated|mentioned|reported) )?in the (?:sources|text)(?: provided| given| below)?\b,?\s*/gi, '')
    .replace(/\baccording to the (?:sources|search results|text)\b,?\s*/gi, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*[-*\u2022]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out;
}
module.exports = {
  getWeather, locateByIp, geocode, describeCode,
  answerFromWeb, search, readPage, stripHtml, cleanAnswer, decodeDdgUrl, instantAnswer,
  newsHeadlines, searchWikipedia
};
