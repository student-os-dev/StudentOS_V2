import type { Config } from './config.ts';
import { isObject, validateVector } from './knowledge.ts';

export interface OllamaMetrics {
  totalMs: number | null;
  loadMs: number | null;
  promptEvalMs: number | null;
  tokenGenerationMs: number | null;
  promptTokens: number | null;
  outputTokens: number | null;
}
export interface EmbeddingResult { embeddings: number[][]; metrics: OllamaMetrics }
export interface GenerationResult { content: string; finishReason: string; metrics: OllamaMetrics }
export interface ModelClient {
  embed(inputs: string[]): Promise<EmbeddingResult>;
  generate(system: string, user: string, schema: Record<string, unknown>): Promise<GenerationResult>;
}
export class OllamaError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 502) {
    super(message);
    this.name = 'OllamaError';
    this.code = code;
    this.status = status;
  }
}
export function milliseconds(value: number): number { return Math.round(value * 1000) / 1000; }
function metrics(response: Record<string, unknown>): OllamaMetrics {
  function count(key: string): number | null {
    const value = response[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }
  function duration(key: string): number | null {
    const value = count(key);
    return value === null ? null : milliseconds(value / 1_000_000);
  }
  return {
    totalMs: duration('total_duration'), loadMs: duration('load_duration'),
    promptEvalMs: duration('prompt_eval_duration'), tokenGenerationMs: duration('eval_duration'),
    promptTokens: count('prompt_eval_count'), outputTokens: count('eval_count')
  };
}
// Escape special-token delimiters in untrusted text before placing it in a raw Qwen prompt.
function escapeDelimiters(value: string): string {
  return value.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}
export function qwenPrompt(system: string, user: string): string {
  return '<|im_start|>system\n' + escapeDelimiters(system) + '<|im_end|>\n' +
    '<|im_start|>user\n' + escapeDelimiters(user) + '<|im_end|>\n' +
    '<|im_start|>assistant\n<think>\n</think>\n\n';
}

export class OllamaClient implements ModelClient {
  private readonly config: Config;
  private readonly fetcher: typeof fetch;
  private generationChecked = false;
  constructor(config: Config, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }
  private async request(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const response = await this.fetcher(this.config.ollamaBaseUrl + path, {
        method: body ? 'POST' : 'GET',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.config.ollamaTimeoutMs)
      });
      if (!response.ok) {
        const code = response.status === 404 ? 'OLLAMA_MODEL_MISSING' : 'OLLAMA_REQUEST_FAILED';
        throw new OllamaError(code, response.status === 404 ?
          'A configured model is unavailable in the existing Ollama server. No model was downloaded.' :
          'Ollama returned HTTP ' + response.status + '.', response.status === 404 ? 503 : 502);
      }
      const result: unknown = await response.json();
      if (!isObject(result) || typeof result.error === 'string') {
        throw new OllamaError('OLLAMA_INVALID_RESPONSE', 'Ollama returned an invalid response.');
      }
      return result;
    } catch (error) {
      if (error instanceof OllamaError) throw error;
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
        throw new OllamaError('OLLAMA_TIMEOUT', 'Ollama timed out. Try again after the current workload finishes.', 504);
      }
      if (error instanceof SyntaxError) throw new OllamaError('OLLAMA_INVALID_RESPONSE', 'Ollama returned invalid JSON.');
      throw new OllamaError('OLLAMA_UNAVAILABLE', 'Cannot reach the existing Ollama server.', 503);
    }
  }
  async installedModel(name: string): Promise<{ name: string; digest: string }> {
    const response = await this.request('/api/tags');
    const canonical = name.includes(':') ? name : name + ':latest';
    const found = Array.isArray(response.models) ? response.models.find((model: unknown) =>
      isObject(model) && (model.name === name || model.name === canonical)) : undefined;
    if (!isObject(found) || typeof found.name !== 'string' || typeof found.digest !== 'string') {
      throw new OllamaError('OLLAMA_MODEL_MISSING', 'Required local model is missing: ' + name + '. No model was downloaded.', 503);
    }
    return { name: found.name, digest: found.digest };
  }
  async prepareGeneration(): Promise<void> {
    if (this.generationChecked) return;
    const response = await this.request('/api/show', { model: this.config.answerModel });
    if (this.config.generationMode === 'qwen3-prefill') {
      const info = isObject(response.model_info) ? response.model_info : {};
      const details = isObject(response.details) ? response.details : {};
      if (info['general.architecture'] !== 'qwen3' && details.family !== 'qwen3') {
        throw new OllamaError('MODEL_MODE_MISMATCH', 'qwen3-prefill requires a Qwen3 model. Configure GENERATION_MODE=chat for another compatible model.', 503);
      }
    } else if (isObject(response.thinking) && Array.isArray(response.thinking.values) && !response.thinking.values.includes(false)) {
      throw new OllamaError('NON_THINKING_UNSUPPORTED', 'The installed model does not support think:false. The approved Qwen3 prompt workaround uses GENERATION_MODE=qwen3-prefill.', 503);
    }
    this.generationChecked = true;
  }
  async embed(inputs: string[]): Promise<EmbeddingResult> {
    if (!inputs.length) throw new Error('At least one embedding input is required.');
    const response = await this.request('/api/embed', {
      model: this.config.embeddingModel, input: inputs, truncate: false,
      keep_alive: this.config.embedKeepAlive,
      options: { num_ctx: this.config.numCtx, num_gpu: this.config.embedNumGpu, num_thread: this.config.numThread, num_batch: this.config.numBatch }
    });
    if (!Array.isArray(response.embeddings) || response.embeddings.length !== inputs.length) {
      throw new OllamaError('OLLAMA_INVALID_RESPONSE', 'Ollama returned the wrong number of embeddings.');
    }
    try {
      for (const embedding of response.embeddings) validateVector(embedding);
      const dimensions = (response.embeddings[0] as number[]).length;
      for (const embedding of response.embeddings) validateVector(embedding, dimensions);
    } catch { throw new OllamaError('OLLAMA_INVALID_RESPONSE', 'Ollama returned invalid embeddings.'); }
    return { embeddings: response.embeddings as number[][], metrics: metrics(response) };
  }
  async generate(system: string, user: string, schema: Record<string, unknown>): Promise<GenerationResult> {
    await this.prepareGeneration();
    const common = {
      model: this.config.answerModel, think: false, stream: false, format: schema,
      keep_alive: this.config.keepAlive,
      options: {
        num_ctx: this.config.numCtx, num_predict: this.config.maxOutputTokens,
        temperature: this.config.temperature, num_thread: this.config.numThread, num_batch: this.config.numBatch
      }
    };
    const raw = this.config.generationMode === 'qwen3-prefill';
    const response = await this.request(raw ? '/api/generate' : '/api/chat', raw ?
      { ...common, raw: true, prompt: qwenPrompt(system, user) } :
      { ...common, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
    const message = isObject(response.message) ? response.message : {};
    const thinking = raw ? response.thinking : message.thinking;
    if (typeof thinking === 'string' && thinking.trim()) {
      throw new OllamaError('UNEXPECTED_THINKING', 'The configured model emitted thinking despite the requested mode.');
    }
    const content = raw ? response.response : message.content;
    if (response.done !== true || typeof content !== 'string' || /<\/?think>/i.test(content)) {
      throw new OllamaError('OLLAMA_INVALID_RESPONSE', 'Ollama did not return a completed answer without thinking.');
    }
    return {
      content, finishReason: typeof response.done_reason === 'string' ? response.done_reason : 'stop',
      metrics: metrics(response)
    };
  }
}

