import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { openDatabase } from '../src/database/database.ts';
import { migrate, MIGRATIONS } from '../src/database/migrate.ts';
import { importTransport } from '../src/database/import-transport.ts';
import { loadDataset, datasetHash, type KnowledgeIndex } from '../src/knowledge.ts';
import { loadConfig, DOCUMENT_PREFIX, QUERY_PREFIX } from '../src/config.ts';
import { createApplication } from '../src/application.ts';
import type { ModelClient } from '../src/ollama.ts';
import { loadAdminConfig, type AdminConfig } from '../src/admin/config.ts';
import { hashPassword, verifyPassword } from '../src/admin/passwords.ts';
import { provisionAdministrator } from '../src/admin/provision.ts';
import { createAdminSecurity } from '../src/admin/security.ts';

const password = 'Test-only-' + randomBytes(24).toString('hex');
const passwordHash = await hashPassword(password);
const dataset = await loadDataset();
const index: KnowledgeIndex = {
  schemaVersion: 1, createdAt: new Date().toISOString(), embeddingModel: 'test', embeddingModelDigest: 'test',
  documentPrefix: DOCUMENT_PREFIX, queryPrefix: QUERY_PREFIX, datasetHash: datasetHash(dataset), dimensions: 2,
  passages: dataset.passages.map(p => ({ ...p, embedding: [1, 0] })),
};
const unusedModel: ModelClient = {
  async embed() { throw new Error('Unexpected model call'); },
  async generate() { throw new Error('Unexpected model call'); },
};
type Security = ReturnType<typeof createAdminSecurity>;
type DB = ReturnType<typeof openDatabase>;
interface Context {
  db: DB; config: AdminConfig; security: Security;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  advance: (ms: number) => void;
}
async function withServer(run: (context: Context) => Promise<void>, overrides: Partial<AdminConfig> = {}) {
  const db = openDatabase(':memory:');
  migrate(db);
  importTransport(db, dataset);
  db.prepare('INSERT INTO administrator_accounts(id, email, password_hash) VALUES (?, ?, ?)').run('test-admin', 'admin@example.invalid', passwordHash);
  db.exec("INSERT INTO department_memberships VALUES ('transport', 'test-admin'); INSERT INTO membership_permissions VALUES ('transport', 'test-admin', 'edit')");
  const config = { ...loadAdminConfig({}), ...overrides };
  let time = Date.now();
  const security = createAdminSecurity(db, config, () => time);
  const app = express();
  app.use(express.json());
  // Only the test harness exposes these permission probes.
  app.post('/checks/edit', security.authenticate, security.csrf, security.requirePermission('edit', () => 'transport'),
    (_req, res) => { res.json({ allowed: true }); });
  app.post('/checks/publish', security.authenticate, security.csrf, security.requirePermission('publish', () => 'transport'),
    (_req, res) => { res.json({ allowed: true }); });
  app.get('/checks/document/:id', security.authenticate, security.requirePermission('edit', req => {
    const row = db.prepare('SELECT department_id FROM documents WHERE id = ?').get(String(req.params.id));
    return row ? String(row.department_id) : null;
  }), (_req, res) => { res.json({ allowed: true }); });
  app.use(security.errorHandler);
  app.use(createApplication(loadConfig({}), index, unusedModel, security));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  try {
    await run({ db, config, security, advance: ms => { time += ms; },
      request: (path, init) => fetch('http://127.0.0.1:' + address.port + path, init) });
  } finally {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    db.close();
  }
}
function login(context: Context, email = 'admin@example.invalid', secret = password, extraHeaders: Record<string, string> = {}) {
  return context.request('/api/admin/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: context.config.origins[0]!, 'X-Admin-Request': '1', ...extraHeaders },
    body: JSON.stringify({ email, password: secret }) });
}
async function signedIn(context: Context, extraHeaders: Record<string, string> = {}) {
  const response = await login(context, undefined, undefined, extraHeaders);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { csrfToken: string; administrator: { id: string }; departments: unknown[] };
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  return { response, body, cookie, headers: { Origin: context.config.origins[0]!, ...extraHeaders, Cookie: cookie, 'X-CSRF-Token': body.csrfToken } };
}

test('scrypt uses independent salts, verifies passwords and rejects malformed/unsupported hashes', async () => {
  const second = await hashPassword(password);
  assert.notEqual(second, passwordHash);
  assert.match(second, /^\$scrypt\$N=32768,r=8,p=3\$/);
  assert.equal(await verifyPassword(password, second), true);
  assert.equal(await verifyPassword(password + 'wrong', second), false);
  assert.equal(await verifyPassword(password, '$scrypt$invalid'), false);
  await assert.rejects(hashPassword('short'), /15 to 128/);
});

test('migration 2 preserves all baseline audit events and immutability, and repeats safely', () => {
  const db = openDatabase(':memory:');
  try {
    migrate(db, MIGRATIONS.slice(0, 1));
    importTransport(db, dataset);
    const before = db.prepare('SELECT * FROM audit_events ORDER BY id').all();
    assert.deepEqual(migrate(db, MIGRATIONS.slice(0, 2)), { applied: [2], currentVersion: 2 });
    assert.deepEqual(db.prepare('SELECT * FROM audit_events ORDER BY id').all(), before);
    assert.deepEqual(migrate(db, MIGRATIONS.slice(0, 2)), { applied: [], currentVersion: 2 });
    assert.throws(() => db.exec('UPDATE audit_events SET id = id'), /append-only/);
    assert.throws(() => db.exec('DELETE FROM audit_events'), /append-only/);
    assert.equal(db.prepare('SELECT count(*) n FROM administrator_accounts').get()!.n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('provisioning creates only explicit grants, no plaintext, and never overwrites an account', async () => {
  const db = openDatabase(':memory:');
  try {
    migrate(db);
    db.exec("INSERT INTO departments(id,name) VALUES ('transport','Transport')");
    const result = await provisionAdministrator(db, ' New@Example.invalid ', password, 'transport', ['edit']);
    const row = db.prepare('SELECT * FROM administrator_accounts WHERE id = ?').get(result.administratorId)!;
    assert.equal(row.email, 'new@example.invalid');
    assert.notEqual(row.password_hash, password);
    assert.equal(await verifyPassword(password, row.password_hash), true);
    assert.deepEqual(db.prepare('SELECT permission FROM membership_permissions').all().map(r => r.permission), ['edit']);
    await assert.rejects(provisionAdministrator(db, 'new@example.invalid', password, 'transport', ['publish']), /already exists/);
    await assert.rejects(provisionAdministrator(db, 'other@example.invalid', password, 'missing', ['edit']), /does not exist/);
    assert.equal(db.prepare('SELECT count(*) n FROM administrator_accounts').get()!.n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM audit_events').get()!.n, 1);
  } finally { db.close(); }
});

test('login, session and logout use HttpOnly cookies and server-side token hashes', async () => withServer(async context => {
  const signed = await signedIn(context);
  const cookieHeader = signed.response.headers.get('set-cookie')!;
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Strict/);
  assert.match(cookieHeader, /Path=\/api\/admin/);
  assert.doesNotMatch(cookieHeader, /; Secure/);
  assert.equal(signed.response.headers.get('cache-control'), 'no-store');
  const token = signed.cookie.split('=')[1]!;
  const stored = context.db.prepare('SELECT * FROM administrator_sessions').get()!;
  assert.equal(stored.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(stored).includes(token));
  const current = await context.request('/api/admin/session', { headers: { Cookie: signed.cookie } });
  assert.equal(current.status, 200);
  const currentText = await current.text();
  assert.ok(!currentText.includes(token) && !currentText.includes(passwordHash) && !currentText.includes(password));
  assert.deepEqual(JSON.parse(currentText).departments, [{ department_id: 'transport', permission: 'edit' }]);
  const logout = await context.request('/api/admin/logout', { method: 'POST', headers: signed.headers });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/);
  assert.equal(context.db.prepare('SELECT count(*) n FROM administrator_sessions').get()!.n, 0);
  assert.equal((await context.request('/api/admin/session', { headers: { Cookie: signed.cookie } })).status, 401);
  const audits = JSON.stringify(context.db.prepare('SELECT * FROM audit_events').all());
  for (const secret of [password, passwordHash, token, signed.body.csrfToken]) assert.ok(!audits.includes(secret));
  assert.match(audits, /login_succeeded/);
  assert.match(audits, /logout/);
}));

test('wrong password, unknown email, disabled account and SQL-injection input have generic failures', async () => withServer(async context => {
  const wrong = await login(context, undefined, 'not the password');
  const missing = await login(context, 'missing@example.invalid');
  const injection = await login(context, "' OR 1=1 --@example.invalid");
  context.db.exec("UPDATE administrator_accounts SET disabled = 1 WHERE id = 'test-admin'");
  const disabled = await login(context);
  assert.equal(wrong.status, 401);
  const expected = await wrong.text();
  for (const response of [missing, injection, disabled]) {
    assert.equal(response.status, 401);
    assert.equal(await response.text(), expected);
  }
  assert.equal(context.db.prepare('SELECT count(*) n FROM administrator_sessions').get()!.n, 0);
}));

test('login protects against login-CSRF, rejects unexpected fields and does not grant browser permissions', async () => withServer(async context => {
  for (const headers of [
    { 'Content-Type': 'application/json', 'X-Admin-Request': '1' },
    { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'X-Admin-Request': '1' },
    { 'Content-Type': 'application/json', Origin: context.config.origins[0]! },
  ]) {
    const response = await context.request('/api/admin/login', { method: 'POST', headers,
      body: JSON.stringify({ email: 'admin@example.invalid', password }) });
    assert.equal(response.status, 403);
  }
  const injected = await context.request('/api/admin/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: context.config.origins[0]!, 'X-Admin-Request': '1' },
    body: JSON.stringify({ email: 'admin@example.invalid', password, departmentId: 'transport', permission: 'publish' }) });
  assert.equal(injected.status, 401);
  assert.equal(context.db.prepare('SELECT count(*) n FROM administrator_sessions').get()!.n, 0);
}));

test('authenticated mutations require valid session-bound CSRF and exact Origin', async () => withServer(async context => {
  const signed = await signedIn(context);
  for (const headers of [
    { Cookie: signed.cookie, Origin: context.config.origins[0]! },
    { ...signed.headers, 'X-CSRF-Token': 'f'.repeat(64) },
    { ...signed.headers, Origin: 'https://evil.example' },
    { Cookie: signed.cookie, 'X-CSRF-Token': signed.body.csrfToken },
  ]) {
    assert.equal((await context.request('/api/admin/logout', { method: 'POST', headers })).status, 403);
    assert.equal(context.db.prepare('SELECT count(*) n FROM administrator_sessions').get()!.n, 1);
  }
  assert.equal((await context.request('/api/admin/logout', { method: 'POST', headers: signed.headers })).status, 204);
}));

test('relogin rotates session and CSRF, invalidating previous cookies and old CSRF tokens', async () => withServer(async context => {
  const first = await signedIn(context);
  const second = await signedIn(context, { Cookie: first.cookie });
  assert.notEqual(first.cookie, second.cookie);
  assert.notEqual(first.body.csrfToken, second.body.csrfToken);
  assert.equal((await context.request('/api/admin/session', { headers: { Cookie: first.cookie } })).status, 401);
  assert.equal((await context.request('/api/admin/logout', { method: 'POST', headers: { ...second.headers, 'X-CSRF-Token': first.body.csrfToken } })).status, 403);
}));

test('idle and absolute expiry reject and delete sessions even with a retained cookie', async () => {
  await withServer(async context => {
    const signed = await signedIn(context);
    context.advance(1001);
    assert.equal((await context.request('/api/admin/session', { headers: signed.headers })).status, 401);
    assert.equal(context.db.prepare('SELECT count(*) n FROM administrator_sessions').get()!.n, 0);
  }, { idleMs: 1000, absoluteMs: 10000 });
  await withServer(async context => {
    const signed = await signedIn(context);
    context.advance(800);
    assert.equal((await context.request('/api/admin/session', { headers: signed.headers })).status, 200);
    context.advance(800);
    assert.equal((await context.request('/api/admin/session', { headers: signed.headers })).status, 401);
  }, { idleMs: 1000, absoluteMs: 1500 });
});

test('login throttles normalized accounts and socket IP, ignores forged forwarding headers, and recovers after expiry', async () => {
  await withServer(async context => {
    assert.equal((await login(context, 'ADMIN@example.invalid', 'bad')).status, 401);
    assert.equal((await login(context, ' admin@example.invalid ', 'bad')).status, 401);
    const blocked = await login(context);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    context.advance(context.config.rateWindowMs + 1);
    assert.equal((await login(context)).status, 200);
  }, { accountAttempts: 2 });
  await withServer(async context => {
    for (let i = 0; i < 2; i++) assert.equal((await login(context, 'unknown' + i + '@example.invalid', 'bad', { 'X-Forwarded-For': '198.51.100.' + i })).status, 401);
    assert.equal((await login(context, 'fresh@example.invalid', 'bad', { 'X-Forwarded-For': '203.0.113.1' })).status, 429);
    // Limits live in SQLite, not the router instance, and cover unknown accounts.
    const recreated = createAdminSecurity(context.db, context.config);
    assert.ok(recreated.router);
    assert.equal(context.db.prepare('SELECT count(*) n FROM login_rate_limits').get()!.n, 3);
  }, { ipAttempts: 2 });
});

test('missing, forged, duplicate and URL-supplied sessions fail closed; disabling/password change revokes sessions', async () => withServer(async context => {
  assert.equal((await context.request('/api/admin/session')).status, 401);
  const signed = await signedIn(context);
  assert.equal((await context.request('/api/admin/session?token=' + signed.cookie.split('=')[1])).status, 401);
  assert.equal((await context.request('/api/admin/session', { headers: { Cookie: context.config.cookieName + '=' + 'a'.repeat(43) } })).status, 401);
  assert.equal((await context.request('/api/admin/session', { headers: { Cookie: signed.cookie + '; ' + signed.cookie } })).status, 401);
  context.db.exec("UPDATE administrator_accounts SET disabled = 1 WHERE id = 'test-admin'");
  assert.equal((await context.request('/api/admin/session', { headers: signed.headers })).status, 401);
  context.db.exec("UPDATE administrator_accounts SET disabled = 0 WHERE id = 'test-admin'");
  const next = await signedIn(context);
  context.db.prepare("UPDATE administrator_accounts SET password_hash = ? WHERE id = 'test-admin'").run(passwordHash);
  assert.equal((await context.request('/api/admin/session', { headers: next.headers })).status, 401);
}));

test('authorization separates edit/publish, checks stored resource department, and honors immediate grant removal', async () => withServer(async context => {
  const signed = await signedIn(context);
  assert.equal((await context.request('/checks/edit', { method: 'POST', headers: signed.headers })).status, 200);
  assert.equal((await context.request('/checks/publish?permission=edit&departmentId=transport', { method: 'POST', headers: signed.headers })).status, 403);
  context.db.exec("INSERT INTO departments(id, name) VALUES ('other-test', 'Test only'); " +
    "INSERT INTO documents(id, department_id, source_key, source_kind) VALUES ('other-document', 'other-test', 'other', 'plain_text')");
  assert.equal((await context.request('/checks/document/other-document?departmentId=transport&permission=edit', { headers: signed.headers })).status, 403);
  assert.equal((await context.request('/checks/document/TRN-001', { headers: signed.headers })).status, 200);
  assert.equal((await context.request('/checks/document/missing', { headers: signed.headers })).status, 403);
  context.db.exec("DELETE FROM membership_permissions WHERE administrator_id = 'test-admin'");
  assert.equal((await context.request('/checks/edit', { method: 'POST', headers: signed.headers })).status, 403);
  context.db.exec("INSERT INTO membership_permissions VALUES ('transport', 'test-admin', 'publish')");
  assert.equal((await context.request('/checks/publish', { method: 'POST', headers: signed.headers })).status, 200);
  assert.equal((await context.request('/checks/edit', { method: 'POST', headers: signed.headers })).status, 403);
  context.db.exec("DELETE FROM membership_permissions; DELETE FROM department_memberships");
  assert.equal((await context.request('/checks/publish', { method: 'POST', headers: signed.headers })).status, 403);
  assert.equal((await context.request('/checks/edit', { method: 'POST', headers: { Origin: context.config.origins[0]! } })).status, 401);
}));

test('audit failure rolls back login/logout and authorization fails closed on database errors', async () => withServer(async context => {
  context.db.exec("CREATE TRIGGER fail_auth_audit BEFORE INSERT ON audit_events WHEN NEW.event_type = 'login_succeeded' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await login(context)).status, 503);
  assert.equal(context.db.prepare('SELECT count(*) n FROM administrator_sessions').get()!.n, 0);
  context.db.exec('DROP TRIGGER fail_auth_audit');
  const signed = await signedIn(context);
  context.db.exec("CREATE TRIGGER fail_auth_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await context.request('/checks/edit', { method: 'POST', headers: signed.headers })).status, 503);
  assert.equal((await context.request('/api/admin/logout', { method: 'POST', headers: signed.headers })).status, 503);
  assert.equal(context.db.prepare('SELECT count(*) n FROM administrator_sessions').get()!.n, 1);
  context.db.exec('DROP TRIGGER fail_auth_audit');
  context.db.exec('DROP TABLE administrator_sessions');
  assert.equal((await context.request('/api/admin/session', { headers: signed.headers })).status, 503);
}));

test('production requires HTTPS configuration and transport; cookies use Secure and __Host prefix', async () => {
  assert.throws(() => loadAdminConfig({ NODE_ENV: 'production' }), /HTTPS/);
  assert.throws(() => loadAdminConfig({ NODE_ENV: 'production', ADMIN_ORIGINS: 'http://localhost:3000' }), /localhost/);
  assert.throws(() => loadAdminConfig({ ADMIN_ORIGINS: 'http://example.com' }), /localhost/);
  assert.throws(() => loadAdminConfig({ HOST: '0.0.0.0' }), /loopback/);
  const config = loadAdminConfig({ NODE_ENV: 'production', ADMIN_ORIGINS: 'https://admin.example.test', ADMIN_TRUST_LOOPBACK_PROXY: '1' });
  await withServer(async context => {
    assert.equal((await login(context)).status, 403);
    const signed = await signedIn(context, { 'X-Forwarded-Proto': 'https' });
    assert.match(signed.response.headers.get('set-cookie')!, /^__Host-/);
    assert.match(signed.response.headers.get('set-cookie')!, /; Secure/);
    assert.match(signed.response.headers.get('set-cookie')!, /Path=\/;/);
    assert.doesNotMatch(signed.response.headers.get('set-cookie')!, /Domain=/);
  }, config);
});

test('composed application leaves anonymous /api/ask behavior unchanged', async () => withServer(async context => {
  const response = await context.request('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ departmentId: 'unknown', question: 'What are the hours?' }) });
  assert.equal(response.status, 200);
  const body = await response.json() as { available: boolean; sources: unknown[] };
  assert.equal(body.available, false);
  assert.deepEqual(body.sources, []);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await context.request('/api/admin/session')).status, 401);
}));
