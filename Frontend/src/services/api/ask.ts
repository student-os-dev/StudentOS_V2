import type { Answer, RequestFailure, SourceReference } from '../../types/conversation.ts';

export class AssistantError extends Error implements RequestFailure {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = true) {
    super(message);
    this.name = 'AssistantError';
    this.code = code;
    this.retryable = retryable;
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isSource(value: unknown): value is SourceReference {
  return object(value) && ['id', 'title', 'passage'].every(key => typeof value[key] === 'string' && String(value[key]).trim());
}
export function backendFailure(status: number, code: string): AssistantError {
  if (status === 503 && code === 'BUSY') {
    return new AssistantError('BUSY', 'The assistant is answering another question. Please wait a moment, then retry.');
  }
  const invalid: Record<string, string> = {
    INVALID_REQUEST: 'This question could not be accepted. Please send a new question of up to 500 characters.',
    INVALID_JSON: 'The request could not be read. Please try sending a new question.',
    BODY_TOO_LARGE: 'This request is too long. Please send a shorter question.',
    UNSUPPORTED_MEDIA_TYPE: 'The request format could not be accepted. Please refresh the page and try again.',
  };
  if (invalid[code]) return new AssistantError(code, invalid[code], false);
  if (status === 504 || code.includes('TIMEOUT')) {
    return new AssistantError(code || 'TIMEOUT', 'The answer took too long to arrive. Your question is saved; you can retry when you are ready.');
  }
  if (code === 'INTERNAL_ERROR') {
    return new AssistantError(code, 'Something went wrong while preparing your answer. Please try again.');
  }
  return new AssistantError(code || 'SERVICE_UNAVAILABLE', 'The Transport Assistant is unavailable right now. Your question is saved. Please try again shortly.');
}
export async function askTransport(question: string, fetcher: typeof fetch = fetch): Promise<Answer> {
  let response: Response;
  try {
    response = await fetcher('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ departmentId: 'transport', question }),
      // Longer than the backend's two possible 120-second model requests.
      // This signal belongs to the request manager, never to a route component.
      signal: AbortSignal.timeout(270_000),
    });
  } catch (error) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw backendFailure(504, 'TIMEOUT');
    }
    throw new AssistantError('NETWORK', 'We could not connect to the Transport Assistant. Your question is saved. Please try again.');
  }
  let body: unknown;
  try { body = await response.json(); }
  catch {
    if (!response.ok) throw backendFailure(response.status, '');
    throw new AssistantError('UNEXPECTED_RESPONSE', 'The assistant returned an unreadable response. Please try again.');
  }
  if (!response.ok) {
    const error = object(body) && object(body.error) ? body.error : {};
    throw backendFailure(response.status, typeof error.code === 'string' ? error.code : '');
  }
  if (!object(body) || typeof body.available !== 'boolean' || typeof body.answer !== 'string' ||
      !body.answer.trim() || !Array.isArray(body.sources) || !body.sources.every(isSource)) {
    throw new AssistantError('UNEXPECTED_RESPONSE', 'The assistant returned an incomplete response. Please try again.');
  }
  // Preserve the backend's answer verbatim, including normal unavailable outcomes.
  return { available: body.available, answer: body.answer, sources: body.sources };
}

