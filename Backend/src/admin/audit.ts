import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type AuthEvent = 'administrator_provisioned' | 'login_succeeded' | 'login_failed' | 'login_rate_limited' |
  'session_required' | 'session_expired' | 'logout' | 'csrf_rejected' | 'origin_rejected' |
  'authorization_denied' | 'authorization_granted';
// Callers supply only fixed event names and server-resolved IDs. No request bodies/headers/URLs.
export function audit(db: DatabaseSync, event: AuthEvent, actorId: string | null = null,
  departmentId: string | null = null, details: { permission?: string } = {}) {
  db.prepare('INSERT INTO audit_events(id, department_id, actor_type, actor_id, event_type, details_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), departmentId, actorId ? 'administrator' : 'system', actorId, event, JSON.stringify(details));
}
