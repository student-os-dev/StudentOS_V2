import { loadConfig } from './config.ts';
import { loadKnowledge } from './knowledge.ts';
import { OllamaClient } from './ollama.ts';
import { createApplication } from './application.ts';
import { openDatabase } from './database/database.ts';
import { loadAdminConfig } from './admin/config.ts';
import { createAdminSecurity } from './admin/security.ts';

let adminDatabase: ReturnType<typeof openDatabase> | undefined;
function closeDatabase() { adminDatabase?.close(); adminDatabase = undefined; }

try {
  const config = loadConfig();
  const adminConfig = loadAdminConfig();
  const client = new OllamaClient(config);
  const embeddingModel = await client.installedModel(config.embeddingModel);
  await client.installedModel(config.answerModel);
  const index = await loadKnowledge(embeddingModel.name, embeddingModel.digest);
  await client.prepareGeneration();
  adminDatabase = openDatabase();
  const admin = createAdminSecurity(adminDatabase, adminConfig);
  const server = createApplication(config, index, client, admin).listen(config.port, config.host, () => {
    console.log('Student OS V2 Phase 1: http://' + config.host + ':' + config.port);
    console.log('Loaded ' + index.passages.length + ' fictional Transport passages from the local JSON index.');
    console.log('Generation mode: ' + config.generationMode + '; think:false; one active request.');
    if (config.generationMode === 'qwen3-prefill') {
      console.log('Using the approved Qwen3 closed-thinking-prefix workaround; this is not native non-thinking support.');
    }
  });
  server.on('error', error => { closeDatabase(); console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { server.close(closeDatabase); server.closeIdleConnections(); });
  }
} catch (error) {
  closeDatabase();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

