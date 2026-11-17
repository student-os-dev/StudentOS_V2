import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, DOCUMENT_PREFIX, QUERY_PREFIX } from '../src/config.ts';
import {
  loadDataset, datasetHash, validateDataset, validateIndex, cosineSimilarity, retrieve, serializeContext,
  type KnowledgeIndex, type RetrievedPassage
} from '../src/knowledge.ts';
import { askQuestion, evidenceSentences, validateClaims, UNAVAILABLE } from '../src/rag.ts';
import { type ModelClient, type OllamaMetrics } from '../src/ollama.ts';

const config = loadConfig({});
const dataset = await loadDataset();
const index: KnowledgeIndex = {
  schemaVersion: 1, createdAt: new Date(0).toISOString(), embeddingModel: 'nomic-embed-text:latest',
  embeddingModelDigest: 'test-digest', documentPrefix: DOCUMENT_PREFIX, queryPrefix: QUERY_PREFIX,
  datasetHash: datasetHash(dataset), dimensions: 2,
  passages: dataset.passages.map((p, i) => ({ ...p, embedding: i === 5 ? [1, 0] : [0, 1] }))
};
const fee = dataset.passages[5]!;
const retrieved: RetrievedPassage[] = [{ ...fee, score: 1 }];
const metrics: OllamaMetrics = { totalMs: 1, loadMs: 0, promptEvalMs: 0, tokenGenerationMs: 1, promptTokens: 10, outputTokens: 5 };
const correct = JSON.stringify({ claims: [{ sourceId: fee.id, quote: fee.text }] });
function fake(content = correct, vector = [1, 0], finishReason = 'stop'): ModelClient {
  return {
    async embed() { return { embeddings: [vector], metrics }; },
    async generate() { return { content, finishReason, metrics }; }
  };
}

test('configuration rejects invalid limits and fixes small-laptop defaults', () => {
  assert.equal(config.numCtx, 2048);
  assert.equal(config.maxOutputTokens, 160);
  assert.equal(config.topK, 2);
  assert.equal(config.embedNumGpu, 0);
  assert.equal(config.generationMode, 'qwen3-prefill');
  for (const env of [
    { RELEVANCE_THRESHOLD: 'NaN' }, { TOP_K: '0' }, { TOP_K: '3' },
    { NUM_CTX: '100' }, { PORT: '' }, { KEEP_ALIVE: '-1' },
    { GENERATION_MODE: 'unsupported' }, { OLLAMA_BASE_URL: 'file:///C:/' }
  ]) assert.throws(() => loadConfig(env));
});

test('the only dataset is explicitly fictional and contains ten Transport passages', () => {
  assert.equal(dataset.fictional, true);
  assert.equal(dataset.passages.length, 10);
  assert.ok(dataset.passages.every(p => p.departmentId === 'transport' && /fictional/.test(p.text)));
  assert.throws(() => validateDataset({ ...dataset, fictional: false }));
  assert.throws(() => validateDataset({ ...dataset, passages: [fee, fee] }));
});

test('cosine similarity uses vector magnitude and rejects invalid vectors', () => {
  assert.equal(cosineSimilarity([2, 0], [5, 0]), 1);
  assert.equal(cosineSimilarity([2, 0], [0, 7]), 0);
  assert.equal(cosineSimilarity([2, 0], [-7, 0]), -1);
  assert.throws(() => cosineSimilarity([0, 0], [1, 0]));
  assert.throws(() => cosineSimilarity([1, 0], [1]));
  assert.throws(() => cosineSimilarity([NaN, 0], [1, 0]));
});

test('department filtering happens before similarity; threshold excludes weak passages', () => {
  // A deliberately invalid vector in a synthetic foreign row must never be evaluated.
  const withForeign = { ...index, passages: [...index.passages, { ...fee, id: 'FOREIGN', departmentId: 'unavailable', embedding: [NaN] }] };
  assert.deepEqual(retrieve(withForeign, 'transport', [1, 0], config).map(p => p.id), [fee.id]);
  assert.deepEqual(retrieve(index, 'unknown', [1, 0], config), []);
  assert.deepEqual(retrieve(index, 'transport', [-1, 0], config), []);
});

test('context budget includes source labels and never truncates a passage', () => {
  const matching = { ...index, passages: index.passages.map(p => ({ ...p, embedding: [1, 0] })) };
  const selected = retrieve(matching, 'transport', [1, 0], { ...config, maxContextChars: 280 });
  assert.equal(selected.length, 1);
  assert.ok(serializeContext(selected).length <= 280);
  assert.equal(selected[0]!.text, dataset.passages[0]!.text);
  assert.deepEqual(retrieve(matching, 'transport', [1, 0], { ...config, maxContextChars: 5 }), []);
  assert.equal(retrieve(matching, 'transport', [1, 0], { ...config, topK: 1 }).length, 1);
});

test('index validation rejects changed data, models, dimensions, prefixes, and corrupt vectors', () => {
  assert.equal(validateIndex(index, dataset, index.embeddingModel, 'test-digest'), index);
  const mutations = [
    { datasetHash: 'changed' }, { embeddingModelDigest: 'different-model' }, { dimensions: 3 },
    { queryPrefix: 'wrong' }, { documentPrefix: 'wrong' },
    { passages: index.passages.slice(1) },
    { passages: index.passages.map((p, i) => i ? p : { ...p, text: 'Changed fictional fact.' }) },
    { passages: index.passages.map((p, i) => i ? p : { ...p, embedding: [0, 0] }) }
  ];
  for (const mutation of mutations) assert.throws(() => validateIndex({ ...index, ...mutation }, dataset, index.embeddingModel, 'test-digest'));
});

test('a full evidence sentence is accepted; altered fee with the same valid ID is rejected', () => {
  assert.deepEqual(validateClaims(correct, retrieved), [{ sourceId: fee.id, quote: fee.text }]);
  for (const quote of [
    fee.text.replace('1,800', '900'),
    fee.text.replace('one teaching semester', 'one year'),
    fee.text + ' Refunds are available.',
    'The semester bus pass costs INR 1,800.'
  ]) assert.equal(validateClaims(JSON.stringify({ claims: [{ sourceId: fee.id, quote }] }), retrieved), null);
});

test('whole-sentence verification preserves negation and qualifications', () => {
  const passage = { ...retrieved[0]!, text: 'In this fictional dataset, Route A does not run on Sundays; exceptions require written approval.' };
  for (const quote of [
    'In this fictional dataset, Route A does run on Sundays; exceptions require written approval.',
    'In this fictional dataset, Route A does not run on Sundays.',
    'exceptions require written approval.'
  ]) assert.equal(validateClaims(JSON.stringify({ claims: [{ sourceId: passage.id, quote }] }), [passage]), null);
  assert.equal(validateClaims(JSON.stringify({ claims: [{ sourceId: passage.id, quote: passage.text }] }), [passage])?.length, 1);
});

test('unretrieved citations, extra claims, duplicate claims, and malformed output fail closed', () => {
  const claim = { sourceId: fee.id, quote: fee.text };
  for (const content of [
    JSON.stringify({ claims: [{ sourceId: 'TRN-001', quote: dataset.passages[0]!.text }] }),
    JSON.stringify({ claims: [claim], answer: 'The pass is free.' }),
    JSON.stringify({ claims: [claim, claim] }),
    JSON.stringify({ claims: [{ ...claim, extra: 'invented' }] }),
    'not json', '<think>reasoning</think>' + correct
  ]) assert.equal(validateClaims(content, retrieved), null);
});

test('supported answer contains the source fact and measured timings', async () => {
  const result = await askQuestion('transport', 'What is the semester pass fee?', index, config, fake());
  assert.equal(result.available, true);
  assert.equal(result.answer, fee.text);
  assert.match(result.answer, /INR 1,800/);
  assert.match(result.answer, /one teaching semester/);
  assert.equal(result.sources[0]!.passage, fee.text);
  assert.ok(evidenceSentences(result.sources[0]!.passage).includes(result.answer));
  assert.ok(result.timings.totalMs >= result.timings.embeddingMs);
  assert.equal(result.ollama.generation?.totalMs, 1);
});

test('a fabricated fact with a valid citation yields unavailable and no references', async () => {
  const content = JSON.stringify({ claims: [{ sourceId: fee.id, quote: fee.text.replace('1,800', '99') }] });
  const result = await askQuestion('transport', 'How much is a pass?', index, config, fake(content));
  assert.equal(result.available, false);
  assert.equal(result.answer, UNAVAILABLE);
  assert.deepEqual(result.sources, []);
});

test('unknown department makes no Ollama calls', async () => {
  const client: ModelClient = {
    async embed() { throw new Error('Must not embed'); },
    async generate() { throw new Error('Must not generate'); }
  };
  const result = await askQuestion('unknown', 'Where is the office?', index, config, client);
  assert.equal(result.available, false);
  assert.deepEqual(result.sources, []);
  assert.equal(result.timings.embeddingMs, 0);
  assert.equal(result.timings.generationMs, 0);
});

test('low relevance skips generation; related but missing information may abstain', async () => {
  const client = fake('', [-1, 0]);
  client.generate = async () => { throw new Error('Must not generate'); };
  const unrelated = await askQuestion('transport', 'Weather?', index, config, client);
  assert.equal(unrelated.available, false);
  assert.equal(unrelated.ollama.generation, null);
  const missing = await askQuestion('transport', 'Are refunds available?', index, config, fake('{"claims":[]}'));
  assert.equal(missing.available, false);
  assert.equal(missing.answer, UNAVAILABLE);
});

test('only bounded retrieved evidence and the question reach generation', async () => {
  const client = fake();
  client.generate = async (system, user, schema) => {
    assert.match(system, /directly answer/);
    const prompt = JSON.parse(user);
    assert.deepEqual(prompt.evidence.map((p: { id: string }) => p.id), [fee.id]);
    assert.ok(JSON.stringify(prompt.evidence).length <= config.maxContextChars);
    assert.equal(prompt.question, 'What is the pass fee?');
    assert.ok(!user.includes(dataset.passages[0]!.text));
    assert.ok(schema.properties);
    return { content: correct, finishReason: 'stop', metrics };
  };
  await askQuestion('transport', 'What is the pass fee?', index, config, client);
});

test('an answer cut off at the token limit is not returned as reliable evidence', async () => {
  const result = await askQuestion('transport', 'Pass fee?', index, config, fake(correct, [1, 0], 'length'));
  assert.equal(result.available, false);
});

