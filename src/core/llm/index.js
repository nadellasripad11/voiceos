'use strict';
/**
 * Building the brain, once, for everyone who needs one.
 *
 * This was main.js's private business, and so every test and benchmark built
 * its own — which meant each one quietly differed from the thing that ships.
 * test-agent.js reported "No groq API key is set" on a machine with a working
 * key, because the app reads credentials.json and the test did not. That is a
 * fact about the test printed as a fact about the product, and it is the same
 * failure the TTS factory was written to stop.
 *
 * Keys live outside config.json on purpose, so that exporting or sharing
 * settings never leaks one.
 */
const fs = require('fs');
const { paths } = require('../paths');
const { createProvider } = require('./provider');
const { FallbackProvider } = require('./fallback');

/** Whatever keys have been stored locally. Absent is normal, not an error. */
function readCredentials() {
  try { return JSON.parse(fs.readFileSync(paths.credentials, 'utf8')); }
  catch { return {}; }
}

/**
 * The provider the app answers with: the configured one, with the configured
 * fallback behind it.
 *
 * @returns {import('./provider').LlmProvider}
 */
function createBrain({ config, logger = console, credentials = null } = {}) {
  const creds = credentials || readCredentials();
  const one = (name) => createProvider(name, {
    baseUrl: name === 'ollama' ? config.get('llm.baseUrl') : undefined,
    keepAlive: config.get('llm.keepAlive'),
    numCtx: config.get('llm.numCtx'),
    apiKey: creds[name] || '',
    logger
  });

  const primaryName = config.get('llm.provider');
  const fallbackName = config.get('llm.fallbackProvider');
  const primary = one(primaryName);

  // Only worth pairing when they are actually different: a provider behind
  // itself is two attempts at the same failure.
  if (!fallbackName || fallbackName === primaryName) return primary;

  logger.info?.(`[llm] ${primaryName} first, ${fallbackName} behind it`);
  return new FallbackProvider({
    primary,
    secondary: one(fallbackName),
    secondaryModel: config.get('llm.fallbackModel') || null,
    logger
  });
}

module.exports = { createBrain, readCredentials };
