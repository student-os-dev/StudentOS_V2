import express from 'express';
import type { Config } from './config.ts';
import type { KnowledgeIndex } from './knowledge.ts';
import type { ModelClient } from './ollama.ts';
import { createApp } from './app.ts';
import type { createAdminSecurity } from './admin/security.ts';

// Keep the existing /api/ask application and its middleware unchanged.
export function createApplication(config: Config, index: KnowledgeIndex, client: ModelClient,
  admin: ReturnType<typeof createAdminSecurity>) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api/admin', admin.router);
  app.use(createApp(config, index, client));
  return app;
}
