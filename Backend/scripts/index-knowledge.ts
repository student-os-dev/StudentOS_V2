import { writeFile, rename } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { loadConfig, INDEX_PATH, DOCUMENT_PREFIX, QUERY_PREFIX } from '../src/config.ts';
import { loadDataset, datasetHash, validateIndex, type KnowledgeIndex, type IndexedPassage } from '../src/knowledge.ts';
import { OllamaClient, milliseconds } from '../src/ollama.ts';

try {
  const start = performance.now();
  const config = loadConfig();
  const client = new OllamaClient(config);
  const dataset = await loadDataset();
  const model = await client.installedModel(config.embeddingModel);
  const passages: IndexedPassage[] = [];
  const batches = [];
  // Small sequential batches bound peak memory use on the target laptop.
  for (let offset = 0; offset < dataset.passages.length; offset += 4) {
    const batch = dataset.passages.slice(offset, offset + 4);
    const batchStart = performance.now();
    const result = await client.embed(batch.map(p => DOCUMENT_PREFIX + p.title + '\n' + p.text));
    for (let i = 0; i < batch.length; i++) passages.push({ ...batch[i]!, embedding: result.embeddings[i]! });
    batches.push({ count: batch.length, wallMs: milliseconds(performance.now() - batchStart), ollama: result.metrics });
  }
  const index: KnowledgeIndex = {
    schemaVersion: 1, createdAt: new Date().toISOString(), embeddingModel: model.name,
    embeddingModelDigest: model.digest, documentPrefix: DOCUMENT_PREFIX, queryPrefix: QUERY_PREFIX,
    datasetHash: datasetHash(dataset), dimensions: passages[0]!.embedding.length, passages
  };
  validateIndex(index, dataset, model.name, model.digest);
  await writeFile(INDEX_PATH + '.tmp', JSON.stringify(index) + '\n', 'utf8');
  await rename(INDEX_PATH + '.tmp', INDEX_PATH);
  console.log(JSON.stringify({
    passages: passages.length, dimensions: index.dimensions, indexPath: INDEX_PATH,
    totalMs: milliseconds(performance.now() - start), batches
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

