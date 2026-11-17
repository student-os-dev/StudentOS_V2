import express, { type Request, type Response, type RequestHandler, type ErrorRequestHandler, type CookieOptions } from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/database.ts';
import { audit } from './audit.ts';
import { normalizeEmail, verifyPassword } from './passwords.ts';
import type { AdminConfig } from './config.ts';
import { PERMISSIONS, type Permission } from './provision.ts';

import { MIGRATIONS } from '../database/migrate.ts';
import { createKnowledgeRouter } from './knowledge-routes.ts';
import type { PublicationService } from '../publishing/service.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const csrfToken = (token: string) => createHmac('sha256', token).update('student-os-admin-csrf-v1').digest('hex');
class Denied extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | undefined;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message); this.status = status; this.code = code; this.retryAfter = retryAfter;
  }
}
interface Session { administratorId: string; token: string; hash: string; expiresAt: number }
function cookieToken(request: Request, name: string): string | null {
  const values = (request.headers.cookie ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(name + '=')).map(part => part.slice(name.length + 1));
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]!) ? values[0]! : null;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createAdminSecurity(db: DatabaseSync, config: AdminConfig, now: () => number = Date.now, publication?: PublicationService) {
  // Deliberately no implicit migrations or database repair at server startup.
  if (db.prepare('SELECT max(version) AS version FROM schema_migrations').get()?.version !== MIGRATIONS.length) {
    throw new Error('Administrator schema is not current. Run npm run db:migrate.');
  }
  const sessions = new WeakMap<Request, Session>();
  let hashing = false; // One expensive password verification at a time on this laptop.
  const cookieOptions: CookieOptions = {
    httpOnly: true, secure: config.secureCookies, sameSite: 'strict',
    path: config.secureCookies ? '/' : '/api/admin',
  };
  const unauthenticated = () => new Denied(401, 'AUTHENTICATION_REQUIRED', 'Administrator authentication required.');
  const wrap = (handler: (request: Request, response: Response) => unknown | Promise<unknown>): RequestHandler =>
    (request, response, next) => { Promise.resolve().then(() => handler(request, response)).then(() => {
      if (!response.headersSent) next();
    }).catch(next); };

  function checkOrigin(request: Request, required: boolean) {
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '');
    if (config.secureCookies && !request.secure &&
        !(config.trustLoopbackProxy && loopback && request.get('X-Forwarded-Proto') === 'https')) {
      throw new Denied(403, 'HTTPS_REQUIRED', 'HTTPS required.');
    }
    const origin = request.get('Origin');
    if ((required && !origin) || (origin && !config.origins.includes(origin)) ||
        request.get('Sec-Fetch-Site') === 'cross-site') {
      audit(db, 'origin_rejected');
      throw new Denied(403, 'REQUEST_REJECTED', 'Request rejected.');
    }
    if (!config.secureCookies && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) {
      throw new Denied(403, 'REQUEST_REJECTED', 'Request rejected.');
    }
  }
  function sessionFor(request: Request): Session {
    const session = sessions.get(request);
    if (!session) throw unauthenticated();
    return session;
  }
  const authenticate = wrap((request, response) => {
    const token = cookieToken(request, config.cookieName);
    const hash = token ? digest(token) : '';
    const row = token ? db.prepare('SELECT s.*, a.disabled FROM administrator_sessions s ' +
      'JOIN administrator_accounts a ON a.id = s.administrator_id WHERE s.token_hash = ?').get(hash) : undefined;
    if (!row || !token || row.disabled !== 0) {
      audit(db, 'session_required');
      response.clearCookie(config.cookieName, cookieOptions);
      throw unauthenticated();
    }
    const time = now();
    if (Number(row.expires_at) <= time || Number(row.last_seen_at) + config.idleMs <= time || time < Number(row.created_at)) {
      transaction(db, () => {
        audit(db, 'session_expired', String(row.administrator_id));
        db.prepare('DELETE FROM administrator_sessions WHERE token_hash = ?').run(hash);
      });
      response.clearCookie(config.cookieName, cookieOptions);
      throw unauthenticated();
    }
    db.prepare('UPDATE administrator_sessions SET last_seen_at = ? WHERE token_hash = ?').run(time, hash);
    sessions.set(request, { administratorId: String(row.administrator_id), token, hash, expiresAt: Number(row.expires_at) });
  });
  const csrf = wrap(request => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    checkOrigin(request, true);
    const session = sessionFor(request);
    const supplied = request.get('X-CSRF-Token') ?? '';
    const expected = csrfToken(session.token);
    if (!/^[0-9a-f]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))) {
      audit(db, 'csrf_rejected', session.administratorId);
      throw new Denied(403, 'CSRF_REJECTED', 'Request rejected.');
    }
  });
  function requirePermission(permission: Permission | readonly Permission[], departmentFromServer: (request: Request) => string | null): RequestHandler {
    const required = typeof permission === 'string' ? [permission] : [...permission];
    if (!required.length || required.some(p => !PERMISSIONS.includes(p))) throw new Error('Unknown server-side permission.');
    return wrap(request => {
      const session = sessionFor(request);
      // The resolver must use a server-owned scope or the stored resource's department.
      // A route department identifier is only a selector; a current DB grant is always required.
      const candidate = departmentFromServer(request);
      const department = typeof candidate === 'string' ?
        db.prepare('SELECT id FROM departments WHERE id = ?').get(candidate) : undefined;
      const departmentId = department ? String(department.id) : null;
      const grant = departmentId ? db.prepare('SELECT p.permission FROM membership_permissions p ' +
        'JOIN department_memberships m ON m.department_id = p.department_id AND m.administrator_id = p.administrator_id ' +
        'JOIN administrator_accounts a ON a.id = m.administrator_id AND a.disabled = 0 ' +
        'WHERE p.department_id = ? AND p.administrator_id = ?')
        .all(departmentId, session.administratorId).find(row => required.includes(row.permission as Permission)) : undefined;
      audit(db, grant ? 'authorization_granted' : 'authorization_denied', session.administratorId, departmentId, { permission: required.join('|') });
      if (!grant) throw new Denied(403, 'FORBIDDEN', 'Access denied.');
    });
  }
  function currentAdministrator(request: Request): string {
    const session = sessionFor(request);
    const row = db.prepare('SELECT s.*, a.disabled FROM administrator_sessions s JOIN administrator_accounts a ON a.id = s.administrator_id WHERE s.token_hash = ?').get(session.hash);
    const time = now();
    if (!row || row.disabled !== 0 || row.administrator_id !== session.administratorId ||
        Number(row.expires_at) <= time || Number(row.last_seen_at) + config.idleMs <= time || Number(row.created_at) > time) throw unauthenticated();
    return session.administratorId;
  }
  function consumeLoginAttempt(email: string, ip: string) {
    return transaction(db, () => {
      const time = now();
      db.prepare('DELETE FROM login_rate_limits WHERE resets_at <= ?').run(time);
      const buckets = [{ key: digest('account:' + email), limit: config.accountAttempts }, { key: digest('ip:' + ip), limit: config.ipAttempts }];
      const rows = buckets.map(bucket => ({ ...bucket, row: db.prepare('SELECT * FROM login_rate_limits WHERE bucket_hash = ?').get(bucket.key) }));
      const blocked = rows.find(item => Number(item.row?.attempts ?? 0) >= item.limit);
      if (blocked) {
        audit(db, 'login_rate_limited');
        return Math.max(1, Math.ceil((Number(blocked.row!.resets_at) - time) / 1000));
      }
      for (const item of rows) {
        db.prepare('INSERT INTO login_rate_limits(bucket_hash, attempts, resets_at) VALUES (?, 1, ?) ' +
          'ON CONFLICT(bucket_hash) DO UPDATE SET attempts = attempts + 1').run(item.key, time + config.rateWindowMs);
      }
      return null;
    });
  }
  function sessionResponse(session: Session) {
    return {
      authenticated: true, administrator: { id: session.administratorId },
      expiresAt: new Date(session.expiresAt).toISOString(),
      csrfToken: csrfToken(session.token),
      departments: db.prepare('SELECT m.department_id, p.permission FROM department_memberships m ' +
        'LEFT JOIN membership_permissions p ON p.department_id = m.department_id AND p.administrator_id = m.administrator_id ' +
        'WHERE m.administrator_id = ? ORDER BY m.department_id, p.permission').all(session.administratorId),
    };
  }
  const router = express.Router();
  router.use((_request, response, next) => {
    response.set({ 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    next();
  });
  router.use(wrap(request => checkOrigin(request, false)));
  const smallJson = express.json({ limit: '4kb', strict: true });
  router.use((request, response, next) => {
    const path = request.path.toLowerCase();
    if (path === '/departments/transport' || path.startsWith('/departments/transport/')) next();
    else smallJson(request, response, next);
  });
  router.post('/login', wrap(async (request, response) => {
    checkOrigin(request, true);
    if (!request.is('application/json') || request.get('X-Admin-Request') !== '1') {
      throw new Denied(403, 'REQUEST_REJECTED', 'Request rejected.');
    }
    const body: unknown = request.body;
    const email = object(body) ? normalizeEmail(body.email) : null;
    const password = object(body) && typeof body.password === 'string' && Buffer.byteLength(body.password, 'utf8') <= 512 ? body.password : '';
    const retry = consumeLoginAttempt(email ?? '<invalid>', request.socket.remoteAddress ?? '<unknown>');
    if (retry !== null) throw new Denied(429, 'LOGIN_FAILED', 'Unable to sign in. Try again later.', retry);
    if (hashing) {
      audit(db, 'login_rate_limited');
      throw new Denied(429, 'LOGIN_FAILED', 'Unable to sign in. Try again later.', 2);
    }
    hashing = true;
    try {
      const row = email ? db.prepare('SELECT id, password_hash, disabled FROM administrator_accounts WHERE email = ?').get(email) : undefined;
      const validShape = object(body) && Object.keys(body).length === 2 && 'email' in body && 'password' in body && password.length > 0;
      const matches = await verifyPassword(password, row?.disabled === 0 ? row.password_hash : null);
      const current = row ? db.prepare('SELECT id, password_hash, disabled FROM administrator_accounts WHERE id = ?').get(row.id!) : undefined;
      if (!validShape || !matches || !current || current.disabled !== 0 || current.password_hash !== row?.password_hash) {
        audit(db, 'login_failed');
        throw new Denied(401, 'LOGIN_FAILED', 'Invalid administrator credentials.');
      }
      const token = randomBytes(32).toString('base64url');
      const time = now();
      const session = { token, hash: digest(token), administratorId: String(current.id), expiresAt: time + config.absoluteMs };
      transaction(db, () => {
        const prior = cookieToken(request, config.cookieName);
        if (prior) db.prepare('DELETE FROM administrator_sessions WHERE token_hash = ?').run(digest(prior));
        db.prepare('DELETE FROM administrator_sessions WHERE administrator_id = ? OR expires_at <= ?').run(session.administratorId, time);
        db.prepare('INSERT INTO administrator_sessions(token_hash, administrator_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)')
          .run(session.hash, session.administratorId, time, time, session.expiresAt);
        audit(db, 'login_succeeded', session.administratorId);
      });
      const result = sessionResponse(session);
      response.cookie(config.cookieName, token, { ...cookieOptions, maxAge: config.absoluteMs });
      response.status(200).json(result);
    } finally { hashing = false; }
  }));
  // All subsequent admin routes require authentication; every mutation also requires CSRF.
  router.use(authenticate, csrf);
  router.use('/departments/transport', createKnowledgeRouter(db, { requirePermission, currentAdministrator }, publication));
  router.get('/session', wrap((request, response) => { response.json(sessionResponse(sessionFor(request))); }));
  router.post('/logout', wrap((request, response) => {
    const session = sessionFor(request);
    transaction(db, () => {
      db.prepare('DELETE FROM administrator_sessions WHERE token_hash = ?').run(session.hash);
      audit(db, 'logout', session.administratorId);
    });
    response.clearCookie(config.cookieName, cookieOptions).status(204).end();
  }));
  router.use((_request, response) => { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Administrator endpoint not found.' } }); });
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof Denied) {
      if (error.retryAfter) response.setHeader('Retry-After', String(error.retryAfter));
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
    } else if (object(error) && ['entity.parse.failed', 'entity.too.large'].includes(String(error.type))) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid administrator request.' } });
    } else {
      // Never log an exception that could include bound SQL values, request data, or secrets.
      console.error('Administrator operation failed.');
      response.status(503).json({ error: { code: 'ADMIN_UNAVAILABLE', message: 'Administrator service unavailable.' } });
    }
  };
  router.use(errorHandler);
  return { router, authenticate, csrf, requirePermission, errorHandler };
}
