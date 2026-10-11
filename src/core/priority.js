'use strict';
/**
 * Keeping the assistant's heavy lifting from making the laptop stutter.
 *
 * Transcription and speech are short bursts of solid CPU. At normal priority
 * they compete evenly with whatever the user is actually looking at, so a
 * browser or a game hitches every time Jarvis hears something. Below normal,
 * Windows hands the CPU to the foreground first and Jarvis takes what is left
 * — which on an idle machine is all of it, so nothing is lost when nobody is
 * competing.
 */
const os = require('os');

/**
 * Drops a child process to below-normal priority. Best effort: a process that
 * has already exited, or a platform that refuses, is not worth failing over.
 *
 * @param {number} pid
 */
function backgroundPriority(pid) {
  if (!pid) return;
  try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
}

/**
 * How many threads a CPU-bound job should use: one per physical core, at most
 * four.
 *
 * Every logical core but one was the old rule, and on a 4-core / 8-thread
 * laptop that meant seven threads that spin-wait on each other. Measured on
 * this machine with a 3-second clip: 7 threads 2.2s median and erratic,
 * 4 threads 1.9s and steady — faster, and half the CPU left for everything
 * else. os does not report physical cores, so this assumes two threads per
 * core, which is true of every Intel and AMD laptop chip that has more than
 * four logical cores.
 */
function workerThreads() {
  const logical = os.cpus().length;
  return Math.max(1, Math.min(4, logical > 4 ? Math.floor(logical / 2) : logical - 1 || 1));
}

module.exports = { backgroundPriority, workerThreads };
