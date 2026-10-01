'use strict';
/**
 * Agent Mode.
 *
 * Two paths to an answer:
 *
 *   1. A deterministic router matches the commands people actually say out loud
 *      ("what's playing", "open Spotify", "turn it up") and runs the tool
 *      directly. No model, no latency, no misinterpretation.
 *   2. Anything the router does not recognise goes to the LLM tool-calling loop.
 *
 * The router exists because it is genuinely better for the common cases, and
 * because on a machine with no usable local model it is the difference between
 * an agent that works and one that does nothing at all.
 *
 * Nothing that sends, creates, changes or deletes runs without the user's
 * approval, unless the tool is marked autoConfirm and the user has allowed that.
 */
const { buildTools, toolSchemas } = require('./tools');

const SYSTEM_PROMPT = `You are VoiceOS, a voice assistant running on the user's own computer.

You receive what the user said out loud. Answer it by calling the tools available to you, then reply.

Rules:
- Prefer calling a tool over guessing. If a tool can get the real answer, call it.
- Reply in one or two short sentences. The user is listening, not reading.
- Never invent file names, song titles, search results or facts. Only state what a tool returned.
- If no tool fits and you do not know, say so plainly.
- Do not describe the tools or your reasoning. Just answer.`;

class Agent {
  constructor({ provider, config, bridge, browser, tts, logger = console, requestConfirmation }) {
    this.provider = provider;
    this.config = config;
    this.bridge = bridge;
    this.browser = browser;
    this.tts = tts;
    this.logger = logger;
    this.requestConfirmation = requestConfirmation;
    this.history = [];
  }

  get ctx() {
    return { bridge: this.bridge, browser: this.browser, config: this.config, logger: this.logger };
  }

  /**
   * Handles one spoken request.
   * @returns {Promise<{question, answer, found, ms, model, usedRouter}>}
   */
  async run(question, { onStage = () => {}, signal } = {}) {
    const started = Date.now();
    const tools = buildTools(this.ctx);

    // 1. Deterministic route.
    const routed = matchIntent(question, tools);
    if (routed) {
      onStage('thinking');
      this.logger.info?.(`[agent] routed "${question}" -> ${routed.tool.name}`);
      const result = await this.execute(routed.tool, routed.args, { signal });
      return this.finish({ question, result, started, model: 'router', usedRouter: true });
    }

    // 2. Model loop.
    const available = await this.provider.available().catch(() => false);
    if (!available) {
      return {
        question,
        answer: this.noBrainMessage(),
        found: [],
        ms: Date.now() - started,
        model: null,
        usedRouter: false,
        needsBrain: true
      };
    }

    onStage('thinking');
    return this.runModelLoop(question, tools, { started, signal, onStage });
  }

  noBrainMessage() {
    const provider = this.config.get('llm.provider');
    if (provider === 'ollama') {
      return 'I can handle direct commands on my own, but that one needs a language model. ' +
             'Install Ollama and run "ollama pull qwen2.5:3b-instruct", or switch to a free Groq or Google key in Settings.';
    }
    return `No ${provider} API key is set. Add a free one in Settings, under Agent.`;
  }

  async runModelLoop(question, tools, { started, signal, onStage }) {
    const schemas = toolSchemas(tools);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const maxIterations = this.config.get('llm.maxToolIterations', 8);

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...this.recentHistory(),
      { role: 'user', content: question }
    ];

    const found = [];
    let model = this.config.get('llm.agentModel') || this.config.get('llm.model');

    for (let i = 0; i < maxIterations; i++) {
      if (signal && signal.aborted) throw new Error('Cancelled');

      const res = await this.provider.chat({
        model,
        messages,
        tools: schemas,
        temperature: this.config.get('llm.temperature', 0.2),
        signal
      });

      if (!res.toolCalls || !res.toolCalls.length) {
        const answer = res.text || 'I am not sure how to answer that.';
        this.remember(question, answer);
        return { question, answer, found, ms: Date.now() - started, model, usedRouter: false };
      }

      messages.push({ role: 'assistant', content: res.text || '', toolCalls: res.toolCalls });

      for (const call of res.toolCalls) {
        const tool = byName.get(call.name);
        if (!tool) {
          messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: `No tool named ${call.name}.` });
          continue;
        }
        onStage('thinking', { tool: tool.name });
        const result = await this.execute(tool, call.args, { signal });
        if (result.found) found.push(...result.found);
        messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: result.summary || (result.ok ? 'Done.' : 'That did not work.')
        });
      }
    }

    // Out of iterations: report what was gathered rather than silently stopping.
    const answer = found.length
      ? 'I gathered what I could but could not finish the request.'
      : 'I could not complete that request.';
    return { question, answer, found, ms: Date.now() - started, model, usedRouter: false, exhausted: true };
  }

  /** Runs one tool, asking for approval first when the tool changes something. */
  async execute(tool, args = {}, { signal } = {}) {
    const needsConfirm =
      tool.mutating &&
      this.config.get('agent.confirmBeforeActions', true) &&
      !(tool.autoConfirm && this.config.get('agent.autoConfirmReadOnly', true));

    if (needsConfirm && this.requestConfirmation) {
      const prompt = tool.confirm ? tool.confirm(args) : { title: `Run ${tool.name}?`, detail: JSON.stringify(args) };
      const approved = await this.requestConfirmation(prompt);
      if (!approved) {
        return { ok: false, summary: 'Cancelled, nothing was changed.', cancelled: true };
      }
    }

    try {
      return await tool.run(args, { signal });
    } catch (err) {
      this.logger.warn?.(`[agent] tool ${tool.name} failed: ${err.message}`);
      return { ok: false, summary: `That did not work: ${err.message}` };
    }
  }

  finish({ question, result, started, model, usedRouter }) {
    const answer = result.summary || (result.ok ? 'Done.' : 'That did not work.');
    this.remember(question, answer);
    return {
      question,
      answer,
      found: result.found || [],
      ms: Date.now() - started,
      model,
      usedRouter,
      cancelled: Boolean(result.cancelled)
    };
  }

  remember(question, answer) {
    if (!this.config.get('agent.rememberConversation', true)) return;
    this.history.push({ question, answer });
    const max = this.config.get('agent.maxHistoryTurns', 8);
    while (this.history.length > max) this.history.shift();
  }

  recentHistory() {
    const out = [];
    for (const turn of this.history) {
      out.push({ role: 'user', content: turn.question });
      out.push({ role: 'assistant', content: turn.answer });
    }
    return out;
  }

  clearHistory() { this.history = []; }
}

// --- Deterministic routing -------------------------------------------------

/**
 * Patterns for the things people genuinely say to a voice assistant.
 *
 * Each returns the tool name and arguments. Order matters: the first match
 * wins, so more specific patterns are listed first.
 */
const INTENTS = [
  // Media
  { re: /^(what(?:'s| is)?\s+(?:this\s+)?(?:song|track|playing|music)|who sings this|what am i listening to)/i,
    tool: 'now_playing' },
  { re: /^(pause|stop)\s*(the\s*)?(music|song|playback|spotify|it)?$/i,
    tool: 'control_playback', args: () => ({ action: 'pause' }) },
  { re: /^(play|resume|unpause)\s*(the\s*)?(music|song|playback|spotify|it)?$/i,
    tool: 'control_playback', args: () => ({ action: 'play' }) },
  { re: /(next|skip)\s*(song|track|this)?/i,
    tool: 'control_playback', args: () => ({ action: 'next' }) },
  { re: /(previous|last|go back a)\s*(song|track)/i,
    tool: 'control_playback', args: () => ({ action: 'previous' }) },

  // Volume
  { re: /(turn (it|the volume) up|louder|volume up)/i,
    tool: 'set_volume', args: () => ({ direction: 'up' }) },
  { re: /(turn (it|the volume) down|quieter|volume down)/i,
    tool: 'set_volume', args: () => ({ direction: 'down' }) },
  { re: /^(mute|unmute|silence)/i,
    tool: 'set_volume', args: () => ({ direction: 'mute' }) },

  // Apps and pages
  { re: /^(?:open|launch|start)\s+(?:the\s+)?(?:app\s+)?(.+?)[.?!]?$/i,
    tool: 'open_app',
    args: (m) => ({ name: m[1].trim() }),
    // "open youtube.com" is a page, not an app.
    guard: (m) => !/\.(com|org|net|io|dev|edu|gov)\b/i.test(m[1])
  },
  { re: /^(?:open|go to|visit)\s+(\S+\.(?:com|org|net|io|dev|edu|gov)\S*)/i,
    tool: 'open_url', args: (m) => ({ url: m[1] }) },

  // Screen and selection
  { re: /(what(?:'s| is| does)?\s+(?:this|that|it)\s+(?:say|mean)|read (?:the|my) screen|what(?:'s| is) on (?:my |the )?screen)/i,
    tool: 'read_screen' },
  { re: /(read (?:the|my) selection|what did i select|what(?:'s| is) selected)/i,
    tool: 'read_selection' },

  // Windows
  { re: /(what(?:'s| is)? open|list (?:my )?windows|what apps are open)/i,
    tool: 'list_windows' },

  // Reminders
  { re: /^remind me (?:to |that )?(.+?)(?:\s+(in .+|at .+|tomorrow.*|today.*))?[.?!]?$/i,
    tool: 'create_reminder', args: (m) => ({ text: m[1].trim(), when: m[2] }) },
  { re: /(what are my reminders|list (?:my )?reminders|what do i need to do)/i,
    tool: 'list_reminders' },

  // Notes
  { re: /^(?:take a note|note|make a note)(?:\s*[:,-]?\s*)(.+)/i,
    tool: 'take_note', args: (m) => ({ text: m[1].trim() }) },

  // Files
  { re: /^(?:find|search for|where is|locate)\s+(?:my\s+|the\s+)?(?:file\s+)?(.+?)(?:\s+file)?[.?!]?$/i,
    tool: 'search_files',
    args: (m) => ({ query: m[1].trim() }),
    // Only treat it as a file search when it sounds like one.
    guard: (m, text) => /\b(file|document|pdf|photo|picture|folder|download)\b/i.test(text)
  },

  // Web
  { re: /^(?:search(?: the web)?(?: for)?|google|look up)\s+(.+?)[.?!]?$/i,
    tool: 'search_web', args: (m) => ({ query: m[1].trim() }) },
  { re: /^(?:what|who|when|where|why|how)\b.+\?$/i,
    tool: 'answer_from_web', args: (_m, text) => ({ query: text.replace(/[?]+$/, '').trim() }) }
];

/** Returns the tool and arguments for a recognised command, or null. */
function matchIntent(text, tools) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (const intent of INTENTS) {
    const m = intent.re.exec(clean);
    if (!m) continue;
    if (intent.guard && !intent.guard(m, clean)) continue;
    const tool = byName.get(intent.tool);
    if (!tool) continue; // the owning app is turned off
    return { tool, args: intent.args ? intent.args(m, clean) : {} };
  }
  return null;
}

module.exports = { Agent, matchIntent, INTENTS, SYSTEM_PROMPT };
