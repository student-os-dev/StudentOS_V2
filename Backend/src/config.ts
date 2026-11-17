import { dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT_ROOT = basename(moduleRoot) === 'dist' ? dirname(moduleRoot) : moduleRoot;
export const DATASET_PATH = resolve(PROJECT_ROOT, 'data', 'transport.json');
export const INDEX_PATH = resolve(PROJECT_ROOT, 'data', 'embeddings.json');
export const DOCUMENT_PREFIX = 'search_document: ';
export const QUERY_PREFIX = 'search_query: ';

export interface Config {
  host: string;
  port: number;
  ollamaBaseUrl: string;
  answerModel: string;
  generationMode: 'chat' | 'qwen3-prefill';
  embeddingModel: string;
  relevanceThreshold: number;
  topK: number;
  maxContextChars: number;
  numCtx: number;
  maxOutputTokens: number;
  temperature: number;
  numThread: number;
  numBatch: number;
  keepAlive: string;
  embedNumGpu: number;
  embedKeepAlive: string;
  ollamaTimeoutMs: number;
  maxQuestionChars: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  function value(key: string, fallback: string): string {
    const result = env[key]?.trim() ?? fallback;
    if (!result) throw new Error(key + ' must not be empty.');
    return result;
  }
  function number(key: string, fallback: number, min: number, max: number, integer = true): number {
    const result = Number(value(key, String(fallback)));
    if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) {
      throw new Error(key + ' must be ' + (integer ? 'an integer' : 'a number') + ' between ' + min + ' and ' + max + '.');
    }
    return result;
  }
  function duration(key: string, fallback: string): string {
    const result = value(key, fallback);
    if (!/^(0|[1-9]\d*(ms|s|m|h))$/.test(result)) throw new Error(key + ' must be 0 or a positive duration such as 2m.');
    return result;
  }
  const baseUrl = new URL(value('OLLAMA_BASE_URL', 'http://localhost:11434'));
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('OLLAMA_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  const generationMode = value('GENERATION_MODE', 'qwen3-prefill');
  if (generationMode !== 'chat' && generationMode !== 'qwen3-prefill') throw new Error('GENERATION_MODE must be chat or qwen3-prefill.');
  return {
    generationMode,
    host: value('HOST', '127.0.0.1'),
    port: number('PORT', 3000, 1, 65535),
    ollamaBaseUrl: baseUrl.toString().replace(/\/$/, ''),
    answerModel: value('ANSWER_MODEL', 'qwen3:4b'),
    embeddingModel: value('EMBEDDING_MODEL', 'nomic-embed-text'),
    relevanceThreshold: number('RELEVANCE_THRESHOLD', 0.70, 0, 1, false),
    topK: number('TOP_K', 2, 1, 2),
    maxContextChars: number('MAX_CONTEXT_CHARS', 1200, 200, 1600),
    numCtx: number('NUM_CTX', 2048, 2048, 8192),
    maxOutputTokens: number('MAX_OUTPUT_TOKENS', 160, 64, 512),
    temperature: number('TEMPERATURE', 0, 0, 1, false),
    numThread: number('NUM_THREAD', 4, 1, 32),
    numBatch: number('NUM_BATCH', 128, 16, 512),
    keepAlive: duration('KEEP_ALIVE', '2m'),
    embedNumGpu: number('EMBED_NUM_GPU', 0, 0, 99),
    embedKeepAlive: duration('EMBED_KEEP_ALIVE', '2m'),
    ollamaTimeoutMs: number('OLLAMA_TIMEOUT_MS', 120000, 100, 300000),
    maxQuestionChars: number('MAX_QUESTION_CHARS', 500, 50, 500)
  };
}

