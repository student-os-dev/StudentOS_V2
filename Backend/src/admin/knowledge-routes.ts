import express, { type Request, type RequestHandler, type Response, type ErrorRequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { Permission } from './provision.ts';
import { createKnowledgeService } from './knowledge-service.ts';
import { KnowledgeError, textInput, reviewInput, emptyInput, resourceId, pagination, expectedTag } from './knowledge-validation.ts';

import { OllamaError } from '../ollama.ts';
import type { PublicationService } from '../publishing/service.ts';

export interface KnowledgeSecurity {
  requirePermission: (permission: Permission | readonly Permission[], department: (request: Request) => string | null) => RequestHandler;
  currentAdministrator: (request: Request) => string;
}
export function createKnowledgeRouter(db: DatabaseSync, security: KnowledgeSecurity, publication?: PublicationService) {
  const router = express.Router();
  const service = createKnowledgeService(db);
  const read = security.requirePermission(['edit', 'publish'], () => 'transport');
  const edit = security.requirePermission('edit', () => 'transport');
  const publish = security.requirePermission('publish', () => 'transport');
  const actor = (request: Request) => () => security.currentAdministrator(request);
  const docId = (request: Request) => resourceId(request.params.documentId);
  const tag = (request: Request) => expectedTag(request.get('If-Match'));
  const send = (response: Response, result: { document: { etag: string } }, status = 200) =>
    response.status(status).set('ETag', result.document.etag).json(result);
  const run = (handler: (request: Request, response: Response) => unknown | Promise<unknown>): RequestHandler =>
    (request, response, next) => { Promise.resolve().then(() => handler(request, response)).catch(next); };
  // Authentication and CSRF already ran on the parent router. Only this subtree accepts larger text bodies.
  router.use((request, _response, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
        (!request.is('application/json') || (request.get('Content-Encoding') && request.get('Content-Encoding') !== 'identity'))) {
      next(new KnowledgeError(415, 'UNSUPPORTED_CONTENT', 'Send uncompressed application/json with manually entered text.'));
    } else next();
  });
  router.use(express.json({ limit: '96kb', strict: true, inflate: false }));
  router.get('/documents', read, run((request, response) => {
    const page = pagination(request.query);
    response.json(service.list(actor(request), page.limit, page.offset));
  }));
  router.post('/documents', edit, run((request, response) => {
    send(response, service.create(actor(request), textInput(request.body)), 201);
  }));
  router.get('/documents/:documentId', read, run((request, response) => {
    send(response, service.view(actor(request), docId(request)));
  }));
  router.get('/documents/:documentId/versions', read, run((request, response) => {
    const page = pagination(request.query);
    response.json(service.versions(actor(request), docId(request), page.limit, page.offset));
  }));
  router.get('/documents/:documentId/versions/:versionId', read, run((request, response) => {
    response.json(service.viewVersion(actor(request), docId(request), resourceId(request.params.versionId)));
  }));
  router.post('/documents/:documentId/revisions', edit, run((request, response) => {
    send(response, service.revise(actor(request), docId(request), tag(request), textInput(request.body, true)), 201);
  }));
  router.post('/documents/:documentId/versions/:versionId/submit', edit, run((request, response) => {
    emptyInput(request.body);
    send(response, service.transition(actor(request), docId(request), resourceId(request.params.versionId), tag(request), 'submit', null));
  }));
  for (const action of ['approve', 'reject'] as const) {
    router.post('/documents/:documentId/versions/:versionId/' + action, publish, run((request, response) => {
      const note = reviewInput(request.body, action === 'reject');
      send(response, service.transition(actor(request), docId(request), resourceId(request.params.versionId), tag(request), action, note));
    }));
  }
  router.post('/documents/:documentId/archive', publish, run((request, response) => {
    emptyInput(request.body);
    send(response, service.archive(actor(request), docId(request), tag(request)));
  }));
  router.post('/documents/:documentId/versions/:versionId/index', publish, run(async (request, response) => {
    emptyInput(request.body);
    if (!publication) throw new KnowledgeError(503, 'INDEXING_UNAVAILABLE', 'Indexing is unavailable.');
    send(response, await publication.index(actor(request), docId(request), resourceId(request.params.versionId), tag(request)));
  }));
  router.post('/documents/:documentId/versions/:versionId/publish', publish, run((request, response) => {
    if (!publication) throw new KnowledgeError(503, 'INDEXING_UNAVAILABLE', 'Publication is unavailable.');
    const body: unknown = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length !== 1 || !('indexId' in body)) throw new KnowledgeError(400, 'INVALID_REQUEST', 'Supply an indexId.');
    send(response, publication.publish(actor(request), docId(request), resourceId(request.params.versionId), tag(request), resourceId(body.indexId)));
  }));
  const errors: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    if (error instanceof OllamaError && error.code === 'BUSY') {
      response.set('Retry-After','2').status(503).json({error:{code:'BUSY',message:'Another inference operation is running. Try again shortly.'}});
    } else if (error instanceof KnowledgeError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
    } else if (typeof error === 'object' && error !== null && 'type' in error &&
        ['entity.parse.failed', 'entity.too.large', 'encoding.unsupported', 'charset.unsupported'].includes(String(error.type))) {
      const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 415;
      response.status(status).json({ error: { code: status === 413 ? 'BODY_TOO_LARGE' : 'INVALID_REQUEST', message: 'Invalid knowledge request.' } });
    } else next(error); // Parent handler fails closed without leaking SQL/bound values.
  };
  router.use(errors);
  return router;
}
