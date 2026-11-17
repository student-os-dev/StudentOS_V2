import { RAG_PIPELINE_VERSION } from './rag.ts';
import { loadConfig } from './config.ts';
import { InferenceGate } from './inference-gate.ts';
import { PublishedKnowledge } from './publishing/published-knowledge.ts';
import { createPublicationService } from './publishing/service.ts';
import { ARTIFACT_DIRECTORY } from './publishing/artifacts.ts';
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
  await client.prepareGeneration();
  adminDatabase = openDatabase();
  const gate = new InferenceGate();
  const published = new PublishedKnowledge(adminDatabase, ARTIFACT_DIRECTORY, embeddingModel);
  const publication = createPublicationService(adminDatabase, client, gate, ARTIFACT_DIRECTORY, embeddingModel, () => client.installedModel(config.embeddingModel));
  const admin = createAdminSecurity(adminDatabase, adminConfig, Date.now, publication);
  const interrupted = publication.recoverInterrupted();
  if (interrupted) console.log('Interrupted index jobs marked failed: ' + interrupted);
  const server = createApplication(config, published, client, admin, gate).listen(config.port, config.host, () => {
    console.log('Student OS V2 Phase 1: http://' + config.host + ':' + config.port);
    console.log('RAG pipeline: ' + RAG_PIPELINE_VERSION + '; process ' + process.pid);
    console.log('Department answers use approved, indexed, explicitly published SQLite knowledge only.');
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

