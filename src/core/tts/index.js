'use strict';
/**
 * Picking a voice engine.
 *
 * Kokoro is the one the app speaks with, but it needs an optional dependency,
 * and Piper needs a downloaded binary; on a given machine either, both or
 * neither may be there. The app must not start mute because the preferred one
 * is missing, so the choice is made in one place.
 *
 * In one place specifically so that tests make the same choice the app does.
 * test-agent-stream constructed Piper directly and reported "speech was
 * produced: 0 clips" on a machine where Piper was never installed and Kokoro
 * was speaking perfectly well — a failure about the test, printed as though it
 * were about the code.
 */
const { KokoroTts } = require('./kokoro');
const { PiperTts } = require('./piper');

/**
 * The engine the app would use, given this config and this machine.
 *
 * @returns {{tts: object|null, engine: string, reason: string}} tts is null
 *   when nothing is installed, which callers should report rather than treat
 *   as silence.
 */
function createTts({ config, logger = console } = {}) {
  const want = config.get('tts.engine', 'kokoro');

  if (want === 'kokoro' && KokoroTts.available()) {
    return {
      engine: 'kokoro',
      reason: 'kokoro-js is installed',
      tts: new KokoroTts({
        voice: config.get('tts.voice', 'af_heart'),
        speed: config.get('tts.speed', 1),
        dtype: config.get('tts.dtype', 'q4'),
        logger
      })
    };
  }
  if (want === 'kokoro') logger.warn?.('[tts] kokoro-js is not installed; falling back to Piper');

  const piper = new PiperTts({
    voice: config.get('tts.piperVoice', 'en_US-amy-medium'),
    speed: config.get('tts.speed', 1),
    logger
  });

  // Piper is a binary on disk rather than a dependency, so "installed" is a
  // question only it can answer, and it answers through status().
  const ready = typeof piper.status === 'function' ? Boolean(piper.status().ready) : true;
  if (!ready) {
    return { engine: 'none', reason: 'neither kokoro-js nor the Piper binary is installed', tts: null };
  }
  return { engine: 'piper', reason: 'the Piper binary is present', tts: piper };
}

module.exports = { createTts };
