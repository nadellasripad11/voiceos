'use strict';
/**
 * Whether what Gemini heard is noise rather than the user: a television in
 * the room, a cough, a scrap of another language. Those were being answered —
 * in Spanish, once the room said "¿Qué?" — so the reply is held until this is
 * known, and dropped when it is noise.
 */
function heardNoise(text) {
  const t = String(text || '').trim();
  if (!/[a-z]{2,}/i.test(t)) return true;                 // no English word at all
  if (/[¿¡]/.test(t)) return true;                         // Spanish punctuation
  const letters = t.replace(/[^\p{L}]/gu, '');
  const foreign = letters.replace(/[a-z]/gi, '');
  if (letters.length > 0 && foreign.length / letters.length > 0.2) return true;
  // A short scrap must have at least one ordinary English word in it, or be
  // said to Jarvis. Long sentences always do; noise and other languages do not.
  const words = t.toLowerCase().match(/[a-z']+/g) || [];
  if (words.length <= 4 && !words.some((w) => w.length > 1 && ENGLISH_COMMON.has(w))) return true;
  return false;
}

const ENGLISH_COMMON = new Set(('jarvis the a an i you me my your it is are was be do does did can could will would what who where when why how which ' +
  'yes no yeah yep nope ok okay sure stop wait cancel thanks thank please hey hi hello bye good bad great fine and or but not ' +
  'this that these those there here now today tomorrow tonight play pause next skip open close turn set show tell find check ' +
  'search look call text send read go get make help again more less louder quieter volume weather time news music song ' +
  'of to in on at for with about from up down out off yes alright right nice cool wow really sorry never mind').split(' '));

module.exports = { heardNoise, ENGLISH_COMMON };
