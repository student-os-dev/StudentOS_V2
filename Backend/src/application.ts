import express from 'express';
import type { Config } from './config.ts';
import type { KnowledgeIndex } from './knowledge.ts';
import type { ModelClient } from './ollama.ts';
import { createApp } from './app.ts';
import type { createAdminSecurity } from './admin/security.ts';

import type { PublishedKnowledge } from './publishing/published-knowledge.ts';
import type { InferenceGate } from './inference-gate.ts';

// Preserve the ask contract while production uses the published-only knowledge source.
export function createApplication(config: Config, index: KnowledgeIndex | PublishedKnowledge, client: ModelClient,
  admin: ReturnType<typeof createAdminSecurity>, gate?: InferenceGate) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api/admin', admin.router);
  app.use(createApp(config, index, client, gate));
  return app;
}
