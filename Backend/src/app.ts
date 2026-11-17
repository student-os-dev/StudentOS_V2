import express, { type ErrorRequestHandler } from 'express';
import { performance } from 'node:perf_hooks';
import type { Config } from './config.ts';
import { isObject, type KnowledgeIndex } from './knowledge.ts';
import { OllamaError, milliseconds, type ModelClient } from './ollama.ts';
import { askQuestion } from './rag.ts';

import type { PublishedKnowledge } from './publishing/published-knowledge.ts';
import type { InferenceGate } from './inference-gate.ts';

export function createApp(config: Config, index: KnowledgeIndex | PublishedKnowledge, client: ModelClient, gate?: InferenceGate) {
  const app = express();
  let busy = false;
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.locals.startedAt = performance.now();
    next();
  });
  app.use(express.json({ limit: '4kb', strict: true }));
  app.post('/api/ask', async (request, response, next) => {
    function failure(status: number, code: string, message: string) {
      return response.status(status).json({
        error: { code, message },
        timings: { totalMs: milliseconds(performance.now() - Number(response.locals.startedAt)) }
      });
    }
    const body: unknown = request.body;
    if (!request.is('application/json')) {
      failure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send application/json.');
      return;
    }
    if (!isObject(body) || Object.keys(body).some(key => !['departmentId', 'question'].includes(key)) ||
        typeof body.departmentId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(body.departmentId) ||
        typeof body.question !== 'string' || !body.question.trim() || body.question.trim().length > config.maxQuestionChars) {
      failure(400, 'INVALID_REQUEST', 'Provide departmentId and a nonempty question of at most ' + config.maxQuestionChars + ' characters.');
      return;
    }
    if (busy) {
      response.setHeader('Retry-After', '2');
      failure(503, 'BUSY', 'One question is already being processed. Try again shortly.');
      return;
    }
    busy = true;
    try {
      const departmentId = body.departmentId, question = body.question.trim();
      const run = async () => {
        const published = 'getIndex' in index ? index : null;
        const snapshot = published ? published.getIndex(departmentId) : index as KnowledgeIndex;
        return askQuestion(departmentId, question, snapshot, config, client,
          Number(response.locals.startedAt), published ? passages => published.isCurrent(passages) : undefined);
      };
      response.json(gate ? await gate.run(run) : await run());
    } catch (error) { next(error); }
    finally { busy = false; }
  });
  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Use POST /api/ask.' } });
  });
  const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    const totalMs = milliseconds(performance.now() - Number(response.locals.startedAt));
    if (error instanceof OllamaError) {
      if (error.code === 'BUSY') response.setHeader('Retry-After', '2');
      response.status(error.status).json({ error: { code: error.code, message: error.message }, timings: { totalMs } });
    } else if (isObject(error) && ['entity.parse.failed', 'entity.too.large'].includes(String(error.type))) {
      const tooLarge = error.type === 'entity.too.large';
      response.status(tooLarge ? 413 : 400).json({
        error: { code: tooLarge ? 'BODY_TOO_LARGE' : 'INVALID_JSON', message: tooLarge ? 'Request body exceeds 4 KB.' : 'Invalid JSON body.' },
        timings: { totalMs }
      });
    } else {
      console.error(error instanceof Error ? error.message : 'Unexpected request error');
      response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' }, timings: { totalMs } });
    }
  };
  app.use(handleError);
  return app;
}

