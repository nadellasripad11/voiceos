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
const { buildTools, toolSchemas, openingFor } = require('./tools');
const { matchIntent, INTENTS } = require('./intents');

const SYSTEM_PROMPT = `You are VoiceOS, a voice assistant running on the user's own computer.

You receive what the user said out loud. Answer it by calling the tools available to you, then reply.

Rules:
- Prefer calling a tool over guessing. If a tool can get the real answer, call it.
- Reply in one or two short sentences. The user is listening, not reading.
- Never invent file names, song titles, search results or facts. Only state what a tool returned.
- If no tool fits and you do not know, say so plainly.
- Do not describe the tools or your reasoning. Just answer.`;

class Agent {
  constructor({ provider, config, bridge, browser, tts, connections, logger = console, requestConfirmation }) {
    this.provider = provider;
    this.config = config;
    this.bridge = bridge;
    this.browser = browser;
    this.connections = connections;
    this.tts = tts;
    this.logger = logger;
    this.requestConfirmation = requestConfirmation;
    this.history = [];
  }

  get ctx() {
    // connections must be here: buildTools skips every provider-backed tool
    // when it is missing, which silently drops Gmail, Calendar, Drive and
    // Classroom and sends those questions to web search instead.
    return {
      bridge: this.bridge,
      browser: this.browser,
      config: this.config,
      connections: this.connections,
      // Tools that have to turn a page of text into a sentence need the model.
      provider: this.provider,
      logger: this.logger
    };
  }

  /**
   * Handles one spoken request.
   * @returns {Promise<{question, answer, found, ms, model, usedRouter}>}
   */
  async run(question, { onStage = () => {}, onOpening = null, onPartial = null, signal } = {}) {
    const started = Date.now();
    const tools = buildTools(this.ctx);

    // 1. Deterministic route.
    const routed = matchIntent(question, tools, this.config);
    if (routed) {
      onStage('thinking');
      this.logger.info?.(`[agent] routed "${question}" -> ${routed.tool.name}`);

      // Say what is about to happen while it happens. Synthesis and the tool
      // run concurrently, so the reply starts immediately rather than after
      // the round trip.
      const opening = openingFor(routed.tool.name);
      if (opening && onOpening) onOpening(opening);

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
    // Without streaming the model path is silent for a second or two, so it
    // gets a filler line. With streaming the real first words arrive in about
    // 90ms, and the filler would only delay them. Keyed on whether this
    // provider actually streams, not on whether a listener was passed, or a
    // hosted provider that cannot stream would say nothing at all.
    const willStream = Boolean(onPartial) && Boolean(this.provider.streams);
    if (onOpening && !willStream) onOpening('Let me think about that.');
    return this.runModelLoop(question, tools, { started, signal, onStage, onPartial });
  }

  /**
   * Loads the model and caches the prompt prefix it will be asked with.
   *
   * Loading the weights is only half the cost. The 24 tool schemas come to
   * about 1600 prompt tokens, and evaluating them took 33.7 seconds on the
   * first request against 141ms on the second, because Ollama caches the
   * prompt prefix between calls. Warming with an empty prompt loads the
   * weights but caches nothing, so the first real question still paid the
   * whole 33 seconds.
   *
   * Sending one request with the production system prompt and tool list, asking
   * for a single token, moves that cost to launch where nobody is waiting.
   */
  async prewarm({ signal } = {}) {
    if (!this.provider || typeof this.provider.warm !== 'function') return false;
    const model = this.config.get('llm.agentModel') || this.config.get('llm.model');
    if (!model) return false;
    if (!(await this.provider.available().catch(() => false))) return false;

    await this.provider.warm(model, { signal });

    // Must be the same system prompt and tools the agent loop sends, or the
    // cached prefix will not match and the work is wasted.
    const tools = toolSchemas(buildTools(this.ctx));
    await this.provider.chat({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'Ready.' }
      ],
      tools,
      temperature: 0,
      maxTokens: 1,
      signal
    });
    return true;
  }

  noBrainMessage() {
    const provider = this.config.get('llm.provider');
    if (provider === 'ollama') {
      return 'I can handle direct commands on my own, but that one needs a language model. ' +
             'Install Ollama and run "ollama pull qwen2.5:3b-instruct", or switch to a free Groq or Google key in Settings.';
    }
    return `No ${provider} API key is set. Add a free one in Settings, under Agent.`;
  }

  async runModelLoop(question, tools, { started, signal, onStage, onPartial = null }) {
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

      // Streamed only when someone is listening, and only while the model
      // might still be writing prose: once it has asked for a tool, the next
      // turn's text is a fresh answer, not a continuation of this one.
      let streamed = '';
      const stream = onPartial && this.provider.streams
        ? (chunk, full) => { streamed = full; onPartial(full, { done: false }); }
        : undefined;

      const res = await this.provider.chat({
        model,
        messages,
        tools: schemas,
        temperature: this.config.get('llm.temperature', 0.2),
        signal,
        onToken: stream
      });

      if (!res.toolCalls || !res.toolCalls.length) {
        const answer = res.text || 'I am not sure how to answer that.';
        if (onPartial) onPartial(answer, { done: true });
        this.remember(question, answer);
        return { question, answer, found, ms: Date.now() - started, model, usedRouter: false };
      }

      // It wants a tool after all. Anything streamed so far was preamble, not
      // the answer, so retract it rather than leaving it on screen.
      if (streamed && onPartial) onPartial('', { done: false, retracted: true });

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
    // A tool may offer a shorter line to read aloud than the one it displays.
    const spoken = result.spoken || null;
    this.remember(question, answer);
    return {
      question,
      answer,
      spoken,
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

module.exports = { Agent, matchIntent, INTENTS, SYSTEM_PROMPT };
