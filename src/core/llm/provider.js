'use strict';
/**
 * One interface over every reasoning backend, so Agent Mode does not care where
 * the model runs.
 *
 *   ollama  — fully local and offline. Free, but needs RAM and ideally a GPU.
 *   gemini  — Google AI Studio free tier. Free key, no card, generous limits.
 *   groq    — Groq free tier. Free key, very fast, open-weight models.
 *
 * All three expose chat with tool calling through the same `chat()` shape, which
 * is what lets Settings swap the brain without touching the agent loop.
 */

/** Normalized tool-call shape the agent loop consumes, regardless of provider. */
function normalizeToolCall(raw, index) {
  return {
    id: raw.id || `call_${index}`,
    name: raw.name,
    args: raw.args || {}
  };
}

/**
 * Reads a newline-delimited JSON stream, handing each object to `onObject`.
 *
 * Both Ollama (bare NDJSON) and OpenAI-compatible endpoints (SSE, so each line
 * is prefixed with `data: `) stream one JSON object per line, so one reader
 * serves both. Chunks arrive split mid-line, hence the buffer.
 */
async function readJsonLines(res, onObject) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      if (line.startsWith('data:')) line = line.slice(5).trim();
      if (!line || line === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      onObject(obj);
    }
  }

  const tail = buffer.trim();
  if (tail && tail !== '[DONE]') {
    try { onObject(JSON.parse(tail.replace(/^data:\s*/, ''))); } catch { /* partial trailing chunk */ }
  }
}

class LlmProvider {
  constructor(opts = {}) {
    this.opts = opts;
    this.logger = opts.logger || console;
  }
  get name() { return 'abstract'; }
  async available() { return false; }
  async listModels() { return []; }
  /** Whether this provider can deliver tokens as they are generated. */
  get streams() { return false; }

  /**
   * Whether answering costs memory on this machine.
   *
   * A local model is held resident — about 1.2GB for the small ones — and that
   * memory comes out of speech synthesis. A hosted one is a URL and costs
   * nothing to keep ready, so the caution that applies to loading the first
   * does not apply to the second.
   */
  get local() { return false; }
  /**
   * @param {object} req
   * @param {(chunk: string, full: string) => void} [req.onToken] called with
   *   each piece of text as it is generated. Providers that cannot stream call
   *   it once with the finished text, so callers need no special case.
   */
  // eslint-disable-next-line no-unused-vars
  async chat({ messages, tools, model, temperature, maxTokens, signal, images, onToken }) {
    throw new Error('not implemented');
  }
}

// --- Ollama ---------------------------------------------------------------

class OllamaProvider extends LlmProvider {
  constructor(opts = {}) {
    super(opts);
    this.baseUrl = (opts.baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.keepAlive = opts.keepAlive || '10m';
    this.numCtx = opts.numCtx || 8192;
  }

  get name() { return 'ollama'; }

  /** Runs here, so loading it takes memory from everything else. */
  get local() { return true; }

  async available() {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const { models = [] } = await res.json();
    return models.map((m) => ({ id: m.name, size: m.size, family: m.details && m.details.family }));
  }

  get streams() { return true; }

  /**
   * Loads the model without asking it anything.
   *
   * A cold model costs about twelve seconds on first use against under two when
   * resident — by far the largest single delay in the whole pipeline — so it is
   * paid at launch instead of in front of the user. Ollama treats an empty
   * prompt as a load-only request.
   */
  async warm(model, { signal } = {}) {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [], keep_alive: this.keepAlive }),
      signal
    });
    if (!res.ok) throw new Error(`Ollama could not load ${model} (HTTP ${res.status})`);
    await res.json().catch(() => null);
    return true;
  }

  async chat({ messages, tools, model, temperature = 0.2, maxTokens, signal, images, onToken }) {
    const stream = Boolean(onToken);
    const body = {
      model,
      messages: messages.map((m) => toOllamaMessage(m, images)),
      stream,
      keep_alive: this.keepAlive,
      options: {
        temperature,
        num_ctx: this.numCtx,
        ...(maxTokens ? { num_predict: maxTokens } : {})
      }
    };
    if (tools && tools.length) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new Error(`Ollama chat failed (HTTP ${res.status}): ${detail}`);
    }

    if (stream) {
      // One NDJSON object per token, with the usage counters on the last one.
      let text = '';
      let toolCalls = [];
      let last = null;

      await readJsonLines(res, (obj) => {
        last = obj;
        const msg = obj.message || {};
        if (msg.content) {
          text += msg.content;
          onToken(msg.content, text);
        }
        // Ollama emits tool calls complete in a single object rather than
        // piecewise, so they can simply be collected.
        if (msg.tool_calls && msg.tool_calls.length) {
          toolCalls = toolCalls.concat(msg.tool_calls);
        }
      });

      return {
        text: text.trim(),
        toolCalls: toolCalls.map((c, i) =>
          normalizeToolCall({ id: c.id, name: c.function && c.function.name, args: c.function && c.function.arguments }, i)),
        raw: last,
        usage: {
          promptTokens: last && last.prompt_eval_count,
          completionTokens: last && last.eval_count,
          ms: last && last.total_duration ? Math.round(last.total_duration / 1e6) : undefined
        },
        model
      };
    }

    const data = await res.json();
    const msg = data.message || {};
    return {
      text: (msg.content || '').trim(),
      toolCalls: (msg.tool_calls || []).map((c, i) =>
        normalizeToolCall({ id: c.id, name: c.function && c.function.name, args: c.function && c.function.arguments }, i)),
      raw: data,
      usage: {
        promptTokens: data.prompt_eval_count,
        completionTokens: data.eval_count,
        ms: data.total_duration ? Math.round(data.total_duration / 1e6) : undefined
      },
      model
    };
  }
}

function toOllamaMessage(m, images) {
  const out = { role: m.role, content: m.content || '' };
  if (m.role === 'tool') {
    out.role = 'tool';
    out.content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (m.name) out.tool_name = m.name;
  }
  if (m.toolCalls && m.toolCalls.length) {
    out.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.args }
    }));
  }
  // Screen context: Ollama takes base64 images (no data: prefix) on the message
  // that should see them.
  if (m.images && m.images.length) out.images = m.images;
  else if (images && images.length && m.role === 'user' && m.attachImages) out.images = images;
  return out;
}

// --- Google Gemini (AI Studio free tier) ----------------------------------

class GeminiProvider extends LlmProvider {
  constructor(opts = {}) {
    super(opts);
    this.apiKey = opts.apiKey || process.env.GEMINI_API_KEY || '';
    this.baseUrl = opts.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  }

  get name() { return 'gemini'; }
  async available() { return Boolean(this.apiKey); }

  async listModels() {
    if (!this.apiKey) return [];
    const res = await fetch(`${this.baseUrl}/models?key=${this.apiKey}`);
    if (!res.ok) throw new Error(`Gemini returned HTTP ${res.status}`);
    const { models = [] } = await res.json();
    return models
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), display: m.displayName }));
  }

  async chat({ messages, tools, model, temperature = 0.2, maxTokens, signal }) {
    if (!this.apiKey) throw new Error('No Gemini API key set. Add one in Settings → Brain (free at aistudio.google.com).');

    // Gemini keeps the system instruction out of the turn list.
    const systemParts = messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
    const contents = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: m.name,
              response: { result: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }
            }
          }]
        });
        continue;
      }
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const img of m.images || []) {
        parts.push({ inlineData: { mimeType: 'image/png', data: img } });
      }
      for (const c of m.toolCalls || []) {
        parts.push({ functionCall: { name: c.name, args: c.args } });
      }
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
    }

    const body = {
      contents,
      generationConfig: {
        temperature,
        ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
        // Thinking off on 2.5: measured 0.55-0.75s with it off, and the
        // newer models that think by default took 6 to 81 seconds — no use
        // for a voice reply.
        ...(/^gemini-2\.5/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {})
      }
    };
    if (systemParts.length) body.systemInstruction = { parts: systemParts };
    if (tools && tools.length) {
      body.tools = [{
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: stripUnsupportedSchema(t.parameters)
        }))
      }];
    }

    // The key goes in a header, not the address, where logs and error
    // messages would carry it.
    const deadline = AbortSignal.timeout(20000);
    const res = await fetch(`${this.baseUrl}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline
    });
    if (res.status === 429) {
      await res.text().catch(() => '');
      throw rateLimited(retryAfterMs(res));
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new Error(`Gemini chat failed (HTTP ${res.status}): ${detail}`);
    }
    const data = await res.json();
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    return {
      text: parts.filter((p) => p.text).map((p) => p.text).join('').trim(),
      toolCalls: parts
        .filter((p) => p.functionCall)
        .map((p, i) => normalizeToolCall({ name: p.functionCall.name, args: p.functionCall.args }, i)),
      raw: data,
      usage: {
        promptTokens: data.usageMetadata && data.usageMetadata.promptTokenCount,
        completionTokens: data.usageMetadata && data.usageMetadata.candidatesTokenCount
      },
      model
    };
  }
}

/**
 * Gemini's function declarations accept only a subset of JSON Schema and reject
 * the request outright on unknown keywords, so they are removed here rather
 * than forcing every tool definition to be written twice.
 */
function stripUnsupportedSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(stripUnsupportedSchema);
  const DROP = new Set([
    '$schema', 'additionalProperties', 'default', 'examples', 'const',
    'oneOf', 'anyOf', 'allOf', 'not', 'patternProperties', 'minLength',
    'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'
  ]);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (DROP.has(k)) continue;
    out[k] = typeof v === 'object' ? stripUnsupportedSchema(v) : v;
  }
  return out;
}

// --- Groq (OpenAI-compatible, free tier) ----------------------------------

/** The longest a reply waits for a busy free tier before saying so. */
const MAX_RATE_WAIT_MS = 8000;

/** Seconds from a 429's retry-after header, as milliseconds. */
function retryAfterMs(res) {
  const v = Number(res.headers.get('retry-after'));
  return Number.isFinite(v) && v >= 0 ? Math.ceil(v * 1000) : null;
}

/** Waits, unless the user cancels first. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); }, { once: true });
  });
}

/**
 * The free tier is used up for now, said the way Jarvis would say it.
 * This message is what the user hears, so it names the wait rather than an
 * HTTP status.
 */
function rateLimited(waitMs) {
  const mins = waitMs ? Math.ceil(waitMs / 60000) : 1;
  const when = !waitMs || waitMs < 90000 ? 'in a minute'
    : mins < 60 ? `in about ${mins} minutes` : 'later today';
  const err = new Error(`I have used up my free thinking time for the moment, sir. Ask me again ${when}.`);
  err.code = 'rate_limited';
  err.retryAfterMs = waitMs;
  return err;
}

class OpenAiCompatibleProvider extends LlmProvider {
  constructor(opts = {}) {
    super(opts);
    this.apiKey = opts.apiKey || '';
    this.baseUrl = (opts.baseUrl || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
    this.providerName = opts.providerName || 'groq';
    // Long enough for a slow answer, short enough that a stalled connection
    // falls through to the local model while the user is still listening.
    this.timeoutMs = opts.timeoutMs || 20000;
  }

  get name() { return this.providerName; }
  async available() { return Boolean(this.apiKey); }

  async listModels() {
    if (!this.apiKey) return [];
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` }
    });
    if (!res.ok) throw new Error(`${this.providerName} returned HTTP ${res.status}`);
    const { data = [] } = await res.json();
    return data.map((m) => ({ id: m.id }));
  }

  get streams() { return true; }

  async chat({ messages, tools, model, temperature = 0.2, maxTokens, signal, onToken }) {
    if (!this.apiKey) {
      throw new Error(`No ${this.providerName} API key set. Add one in Settings → Brain (free at console.groq.com).`);
    }
    const stream = Boolean(onToken);
    const body = {
      model,
      temperature,
      ...(stream ? { stream: true } : {}),
      messages: messages.map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'tool',
            tool_call_id: m.toolCallId || m.id,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          };
        }
        const out = { role: m.role, content: m.content || '' };
        if (m.images && m.images.length) {
          out.content = [
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
            ...m.images.map((d) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${d}` } }))
          ];
        }
        if (m.toolCalls && m.toolCalls.length) {
          out.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) }
          }));
        }
        return out;
      }),
      ...(maxTokens ? { max_tokens: maxTokens } : {})
    };
    if (tools && tools.length) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
    }

    // A hosted call with no deadline can hang for ever, and a voice assistant
    // that hangs is indistinguishable from one that ignored you: the log
    // showed "heard ..." and then simply nothing, no answer and no error.
    // A timeout turns that silence into a failure the fallback can act on.
    const send = () => {
      const deadline = AbortSignal.timeout(this.timeoutMs);
      return fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline
      });
    };

    let res = await send();

    // Busy is usually the per-minute token cap, and Groq says how long until
    // it clears — typically a few seconds. Waiting that out once is better
    // than failing an answer the user is already listening for; a long wait
    // (the daily cap) is reported instead, since nobody holds on for minutes.
    if (res.status === 429) {
      const wait = retryAfterMs(res);
      await res.text().catch(() => '');
      if (wait != null && wait <= MAX_RATE_WAIT_MS && !(signal && signal.aborted)) {
        this.logger.info?.(`[llm] ${this.providerName} is busy; retrying in ${wait}ms`);
        await sleep(wait, signal);
        res = await send();
      }
      if (res.status === 429) {
        const again = retryAfterMs(res) ?? wait;
        await res.text().catch(() => '');
        throw rateLimited(again);
      }
    }

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new Error(`${this.providerName} chat failed (HTTP ${res.status}): ${detail}`);
    }

    if (stream) {
      // SSE deltas. Unlike Ollama, tool calls arrive piecewise: the name comes
      // in one delta and the arguments accumulate across several, keyed by
      // index, so they have to be reassembled rather than just collected.
      let text = '';
      const calls = new Map();

      await readJsonLines(res, (obj) => {
        const delta = ((obj.choices || [])[0] || {}).delta || {};
        if (delta.content) {
          text += delta.content;
          onToken(delta.content, text);
        }
        for (const c of delta.tool_calls || []) {
          const key = c.index != null ? c.index : calls.size;
          const prev = calls.get(key) || { id: c.id, name: '', args: '' };
          if (c.id) prev.id = c.id;
          if (c.function && c.function.name) prev.name = c.function.name;
          if (c.function && c.function.arguments) prev.args += c.function.arguments;
          calls.set(key, prev);
        }
      });

      return {
        text: text.trim(),
        toolCalls: [...calls.values()].map((c, i) =>
          normalizeToolCall({ id: c.id, name: c.name, args: safeJson(c.args) }, i)),
        raw: null,
        usage: {},
        model
      };
    }

    const data = await res.json();
    const msg = ((data.choices || [])[0] || {}).message || {};
    return {
      text: (msg.content || '').trim(),
      toolCalls: (msg.tool_calls || []).map((c, i) =>
        normalizeToolCall({ id: c.id, name: c.function && c.function.name, args: safeJson(c.function && c.function.arguments) }, i)),
      raw: data,
      usage: {
        promptTokens: data.usage && data.usage.prompt_tokens,
        completionTokens: data.usage && data.usage.completion_tokens
      },
      model
    };
  }
}

function safeJson(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

// --- Factory --------------------------------------------------------------

const FREE_PROVIDER_NOTES = {
  ollama: 'Local and offline. No account. Needs RAM, ideally a GPU.',
  gemini: 'Google AI Studio free tier. Free key, no credit card.',
  groq: 'Groq free tier. Free key, fastest option on weak hardware.'
};

function createProvider(name, opts = {}) {
  switch ((name || 'ollama').toLowerCase()) {
    case 'ollama': return new OllamaProvider(opts);
    case 'gemini': case 'google': return new GeminiProvider(opts);
    case 'groq': return new OpenAiCompatibleProvider({ ...opts, providerName: 'groq', baseUrl: opts.baseUrl || 'https://api.groq.com/openai/v1' });
    case 'openai-compatible': return new OpenAiCompatibleProvider(opts);
    default: throw new Error(`Unknown LLM provider '${name}'. Known: ollama, gemini, groq, openai-compatible`);
  }
}

module.exports = {
  LlmProvider,
  OllamaProvider,
  GeminiProvider,
  OpenAiCompatibleProvider,
  createProvider,
  FREE_PROVIDER_NOTES,
  stripUnsupportedSchema
};
