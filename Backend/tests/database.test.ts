import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PROJECT_ROOT, DATASET_PATH, INDEX_PATH } from '../src/config.ts';
import { loadDataset } from '../src/knowledge.ts';
import { openDatabase } from '../src/database/database.ts';
import { migrate, MIGRATIONS } from '../src/database/migrate.ts';
import { importTransport, sha256 } from '../src/database/import-transport.ts';

const dataset = await loadDataset();
function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare('SELECT count(*) AS n FROM ' + table).get()!.n);
}
function fixture(run: (db: DatabaseSync) => void) {
  const db = openDatabase(':memory:');
  try { migrate(db); run(db); } finally { db.close(); }
}
function seed(db: DatabaseSync) { importTransport(db, dataset); }
function administrator(db: DatabaseSync) {
  // Random, unrecoverable test password; never creates a usable/default credential.
  const salt = randomBytes(16);
  const hash = '$scrypt$' + salt.toString('hex') + '$' + scryptSync(randomBytes(32), salt, 32).toString('hex');
  db.prepare('INSERT INTO administrator_accounts(id, email, password_hash) VALUES (?, ?, ?)')
    .run('test-admin', 'test@example.invalid', hash);
  db.exec("INSERT INTO department_memberships VALUES ('transport', 'test-admin')");
}
function index(db: DatabaseSync, id = 'index-1', versionId = 'TRN-001:v1', documentId = 'TRN-001') {
  db.prepare('INSERT INTO indexing_metadata(id, version_id, document_id, department_id, embedding_model, model_digest, ' +
    "dimensions, document_prefix, query_prefix, chunker_version) VALUES (?, ?, ?, 'transport', 'test-model', 'test-digest', 2, 'doc:', 'query:', 'baseline-v1')")
    .run(id, versionId, documentId);
}
function publish(db: DatabaseSync) {
  db.exec("INSERT INTO publication_pointers(document_id, department_id, version_id, index_id, published_by) " +
    "VALUES ('TRN-001', 'transport', 'TRN-001:v1', 'index-1', 'test-admin')");
}

test('migration initializes all foundation tables and repeats without changing history', () => {
  const db = openDatabase(':memory:');
  try {
    assert.deepEqual(migrate(db), { applied: MIGRATIONS.map(m => m.version), currentVersion: MIGRATIONS.length });
    const history = db.prepare('SELECT * FROM schema_migrations').all();
    assert.deepEqual(migrate(db), { applied: [], currentVersion: MIGRATIONS.length });
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(), history);
    for (const table of ['departments', 'administrator_accounts', 'department_memberships', 'membership_permissions',
      'documents', 'document_versions', 'version_reviews', 'knowledge_chunks', 'indexing_metadata', 'publication_pointers', 'audit_events']) {
      assert.equal(count(db, table), 0);
    }
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers, 1);
  } finally { db.close(); }
});

test('migration history rejects altered or unknown migrations', () => fixture(db => {
  assert.throws(() => migrate(db, [{ ...MIGRATIONS[0]!, sql: MIGRATIONS[0]!.sql + '\n-- changed' }]), /history differs/);
  assert.throws(() => migrate(db, []), /history differs/);
  assert.throws(() => migrate(db, [{ version: 2, name: 'gap', sql: 'SELECT 1' }]), /sequential/);
  assert.equal(count(db, 'schema_migrations'), MIGRATIONS.length);
}));

test('failed migrations roll back schema and history; later numbered migrations apply once', () => fixture(db => {
  const second = { version: MIGRATIONS.length + 1, name: 'test-second', sql: 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY) STRICT;' };
  const broken = { version: MIGRATIONS.length + 2, name: 'test-broken', sql: 'CREATE TABLE temporary_probe(id INTEGER); INVALID SQL;' };
  assert.throws(() => migrate(db, [...MIGRATIONS, second, broken]));
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('migration_probe', 'temporary_probe')").get()!.n, 0);
  assert.equal(count(db, 'schema_migrations'), MIGRATIONS.length);
  assert.deepEqual(migrate(db, [...MIGRATIONS, second]), { applied: [MIGRATIONS.length + 1], currentVersion: MIGRATIONS.length + 1 });
  assert.deepEqual(migrate(db, [...MIGRATIONS, second]), { applied: [], currentVersion: MIGRATIONS.length + 1 });
}));

test('baseline import preserves exact IDs, titles, text, provenance and remains idempotent', () => fixture(db => {
  const beforeDataset = readFileSync(DATASET_PATH);
  const beforeIndex = existsSync(INDEX_PATH) ? readFileSync(INDEX_PATH) : null;
  assert.deepEqual(importTransport(db, dataset), { inserted: 10, unchanged: 0, publicationsCreated: 0, administratorsCreated: 0 });
  const before = db.prepare('SELECT * FROM audit_events ORDER BY id').all();
  assert.deepEqual(importTransport(db, dataset), { inserted: 0, unchanged: 10, publicationsCreated: 0, administratorsCreated: 0 });
  assert.deepEqual(db.prepare('SELECT * FROM audit_events ORDER BY id').all(), before);
  for (const p of dataset.passages) {
    const version = db.prepare('SELECT * FROM document_versions WHERE id = ?').get(p.id + ':v1')!;
    assert.equal(version.document_id, p.id);
    assert.equal(version.title, p.title);
    assert.equal(version.content_text, p.text);
    assert.equal(version.content_sha256, sha256(p.text));
    const chunk = db.prepare('SELECT * FROM knowledge_chunks WHERE id = ?').get(p.id)!;
    assert.equal(chunk.text, p.text);
    assert.equal(JSON.parse(String(chunk.locator_json)).passageId, p.id);
  }
  for (const table of ['documents', 'document_versions', 'knowledge_chunks', 'version_reviews', 'audit_events']) assert.equal(count(db, table), 10);
  for (const table of ['administrator_accounts', 'department_memberships', 'membership_permissions', 'indexing_metadata', 'publication_pointers']) {
    assert.equal(count(db, table), 0);
  }
  assert.equal(db.prepare("SELECT count(*) n FROM version_reviews WHERE status = 'draft'").get()!.n, 10);
  assert.deepEqual(readFileSync(DATASET_PATH), beforeDataset);
  if (beforeIndex) assert.deepEqual(readFileSync(INDEX_PATH), beforeIndex);
  else assert.equal(existsSync(INDEX_PATH), false);
}));

test('import fails on changed baseline or incomplete records without overwriting', () => fixture(db => {
  seed(db);
  const changed = structuredClone(dataset);
  changed.passages[9]!.text += ' A changed claim.';
  assert.throws(() => importTransport(db, changed), /conflict/);
  assert.equal(count(db, 'document_versions'), 10);
  assert.equal(db.prepare("SELECT content_text FROM document_versions WHERE id = 'TRN-010:v1'").get()!.content_text, dataset.passages[9]!.text);
  assert.throws(() => importTransport(db, { ...dataset, passages: dataset.passages.slice(1) }), /exactly/);
}));

test('late import conflict rolls back all earlier inserts in that import', () => fixture(db => {
  db.exec("INSERT INTO departments(id, name) VALUES ('transport', 'Transport');" +
    "INSERT INTO documents(id, department_id, source_key, source_kind) VALUES ('TRN-010', 'transport', 'different-source', 'plain_text')");
  assert.throws(() => seed(db), /TRN-010/);
  assert.equal(count(db, 'documents'), 1);
  assert.equal(count(db, 'document_versions'), 0);
  assert.equal(count(db, 'knowledge_chunks'), 0);
  assert.equal(count(db, 'audit_events'), 0);
}));

test('foreign keys reject orphaned and cross-department document, chunk, membership and audit references', () => fixture(db => {
  seed(db);
  db.exec("INSERT INTO departments(id, name) VALUES ('test-only', 'Test fixture')");
  assert.throws(() => db.exec("INSERT INTO documents(id, department_id, source_key, source_kind) VALUES ('orphan', 'missing', 'x', 'plain_text')"), /FOREIGN KEY/);
  assert.throws(() => db.exec("INSERT INTO department_memberships VALUES ('transport', 'missing')"), /FOREIGN KEY/);
  assert.throws(() => db.exec("INSERT INTO membership_permissions VALUES ('transport', 'missing', 'edit')"), /FOREIGN KEY/);
  assert.throws(() => db.exec("INSERT INTO document_versions(id, document_id, department_id, version_number, title, content_text, content_sha256) " +
    "SELECT 'cross', document_id, 'test-only', 2, title, content_text, content_sha256 FROM document_versions WHERE id = 'TRN-001:v1'"), /FOREIGN KEY/);
  assert.throws(() => db.exec("INSERT INTO knowledge_chunks(id, version_id, document_id, department_id, ordinal, text, content_sha256, locator_json) " +
    "SELECT 'cross', version_id, document_id, 'test-only', 1, text, content_sha256, locator_json FROM knowledge_chunks WHERE id = 'TRN-001'"), /FOREIGN KEY/);
  assert.throws(() => db.exec("INSERT INTO audit_events(id, department_id, document_id, actor_type, event_type, details_json) " +
    "VALUES ('cross', 'test-only', 'TRN-001', 'system', 'test', '{}')"), /FOREIGN KEY/);
  assert.throws(() => db.exec("INSERT INTO indexing_metadata(id, version_id, document_id, department_id, embedding_model, model_digest, " +
    "dimensions, document_prefix, query_prefix, chunker_version) VALUES ('cross', 'TRN-001:v1', 'TRN-001', 'test-only', 'model', 'digest', 2, 'd:', 'q:', 'v1')"), /eligible approved/);
  assert.throws(() => db.exec("INSERT INTO knowledge_chunks(id, version_id, document_id, department_id, ordinal, text, content_sha256, locator_json) " +
    "SELECT 'wrong-doc', version_id, 'TRN-002', department_id, 1, text, content_sha256, locator_json FROM knowledge_chunks WHERE id = 'TRN-001'"), /FOREIGN KEY/);
  assert.throws(() => db.exec("DELETE FROM departments WHERE id = 'transport'"), /FOREIGN KEY/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}));

test('unique document keys, version numbers and permission grants are enforced; plaintext password is rejected', () => fixture(db => {
  seed(db);
  administrator(db);
  assert.throws(() => db.exec("INSERT INTO administrator_accounts(id, email, password_hash) VALUES ('bad', 'bad@example.invalid', 'plaintext')"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO documents(id, department_id, source_key, source_kind) VALUES ('duplicate', 'transport', 'TRN-001', 'plain_text')"), /UNIQUE/);
  assert.throws(() => db.exec("INSERT INTO document_versions(id, document_id, department_id, version_number, title, content_text, content_sha256) " +
    "SELECT 'duplicate', document_id, department_id, version_number, title, content_text, content_sha256 FROM document_versions WHERE id = 'TRN-001:v1'"), /UNIQUE/);
  db.exec("INSERT INTO membership_permissions VALUES ('transport', 'test-admin', 'edit')");
  assert.throws(() => db.exec("INSERT INTO membership_permissions VALUES ('transport', 'test-admin', 'edit')"), /UNIQUE/);
  assert.throws(() => db.exec("INSERT INTO membership_permissions VALUES ('transport', 'test-admin', 'superuser')"), /CHECK/);
}));

test('versions, chunks and audit are immutable, including REPLACE; a new version preserves prior citations', () => fixture(db => {
  seed(db);
  for (const table of ['document_versions', 'knowledge_chunks', 'audit_events']) {
    assert.throws(() => db.exec('UPDATE ' + table + ' SET id = id'), /immutable|append-only/);
    assert.throws(() => db.exec('DELETE FROM ' + table), /immutable|append-only/);
    assert.throws(() => db.exec('INSERT OR REPLACE INTO ' + table + ' SELECT * FROM ' + table + ' LIMIT 1'), /immutable|append-only/);
  }
  db.exec("INSERT INTO document_versions(id, document_id, department_id, version_number, title, content_text, content_sha256) " +
    "SELECT 'TRN-001:v2', document_id, department_id, 2, title, content_text, content_sha256 FROM document_versions WHERE id = 'TRN-001:v1'");
  assert.equal(count(db, 'document_versions'), 11);
  assert.equal(db.prepare("SELECT content_text FROM document_versions WHERE id = 'TRN-001:v1'").get()!.content_text, dataset.passages[0]!.text);
  assert.deepEqual(importTransport(db, dataset), { inserted: 0, unchanged: 10, publicationsCreated: 0, administratorsCreated: 0 });
}));

test('publication requires matching approved version and ready index; archive cannot leave a live pointer', () => fixture(db => {
  seed(db);
  administrator(db);
  assert.throws(() => index(db), /eligible approved/);
  assert.throws(() => publish(db), /Publication requires/);
  db.exec("UPDATE version_reviews SET status = 'approved', reviewed_by = 'test-admin', reviewed_at = '2026-01-01T00:00:00Z' WHERE version_id = 'TRN-001:v1'");
  index(db);
  assert.throws(() => publish(db), /Publication requires/);
  assert.throws(() => db.exec("UPDATE indexing_metadata SET status = 'ready'"), /CHECK/);
  db.prepare("UPDATE indexing_metadata SET status = 'ready', artifact_path = 'indexes/test.json', artifact_sha256 = ?, " +
    "chunk_count = 1, completed_at = '2026-01-01T00:00:00Z' WHERE id = 'index-1'").run('a'.repeat(64));
  publish(db);
  assert.throws(() => db.exec("UPDATE publication_pointers SET version_id = 'TRN-002:v1'"), /Publication requires/);
  assert.throws(() => db.exec("UPDATE indexing_metadata SET status = 'failed' WHERE id = 'index-1'"), /immutable/);
  assert.throws(() => db.exec("UPDATE version_reviews SET status = 'draft' WHERE version_id = 'TRN-001:v1'"), /publication pointer/);
  assert.throws(() => db.exec("UPDATE documents SET archived_at = '2026-01-01' WHERE id = 'TRN-001'"), /publication pointer/);
  db.exec("DELETE FROM publication_pointers WHERE document_id = 'TRN-001'; UPDATE documents SET archived_at = '2026-01-01' WHERE id = 'TRN-001'");
  assert.throws(() => publish(db), /Publication requires/);
  assert.equal(count(db, 'document_versions'), 10);
  assert.equal(count(db, 'knowledge_chunks'), 10);
}));

test('file database survives reopen, repeats migration/import and supports truly read-only inspection', () => {
  const tempRoot = join(PROJECT_ROOT, '.tmp');
  mkdirSync(tempRoot, { recursive: true });
  const directory = mkdtempSync(join(tempRoot, 'database-test-'));
  const path = join(directory, 'test.sqlite');
  try {
    let db = openDatabase(path);
    try { migrate(db); seed(db); } finally { db.close(); }
    db = openDatabase(path);
    try {
      assert.deepEqual(migrate(db), { applied: [], currentVersion: MIGRATIONS.length });
      assert.equal(importTransport(db, dataset).unchanged, 10);
      assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
    } finally { db.close(); }
    db = openDatabase(path, true);
    try {
      assert.equal(count(db, 'document_versions'), 10);
      assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.throws(() => db.exec("INSERT INTO departments(id, name) VALUES ('no-write', 'No write')"), /readonly/);
    } finally { db.close(); }
    assert.throws(() => openDatabase(join(directory, 'missing.sqlite'), true));
  } finally {
    const within = relative(tempRoot, directory);
    if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Unsafe test cleanup path');
    rmSync(directory, { recursive: true });
  }
});
