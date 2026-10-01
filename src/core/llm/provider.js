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

class LlmProvider {
  constructor(opts = {}) {
    this.opts = opts;
    this.logger = opts.logger || console;
  }
  get name() { return 'abstract'; }
  async available() { return false; }
  async listModels() { return []; }
  // eslint-disable-next-line no-unused-vars
  async chat({ messages, tools, model, temperature, maxTokens, signal, images }) {
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

  async chat({ messages, tools, model, temperature = 0.2, maxTokens, signal, images }) {
    const body = {
      model,
      messages: messages.map((m) => toOllamaMessage(m, images)),
      stream: false,
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
        ...(maxTokens ? { maxOutputTokens: maxTokens } : {})
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

    const res = await fetch(`${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
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

class OpenAiCompatibleProvider extends LlmProvider {
  constructor(opts = {}) {
    super(opts);
    this.apiKey = opts.apiKey || '';
    this.baseUrl = (opts.baseUrl || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
    this.providerName = opts.providerName || 'groq';
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

  async chat({ messages, tools, model, temperature = 0.2, maxTokens, signal }) {
    if (!this.apiKey) {
      throw new Error(`No ${this.providerName} API key set. Add one in Settings → Brain (free at console.groq.com).`);
    }
    const body = {
      model,
      temperature,
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

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new Error(`${this.providerName} chat failed (HTTP ${res.status}): ${detail}`);
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
