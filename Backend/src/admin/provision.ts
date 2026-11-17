import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/database.ts';
import { hashPassword, normalizeEmail } from './passwords.ts';
import { audit } from './audit.ts';

export const PERMISSIONS = ['edit', 'review', 'publish', 'archive'] as const;
export type Permission = typeof PERMISSIONS[number];
export async function provisionAdministrator(db: DatabaseSync, email: string, password: string,
  departmentId: string, permissions: readonly Permission[]) {
  const normalized = normalizeEmail(email);
  if (!normalized || !permissions.length || new Set(permissions).size !== permissions.length ||
      !permissions.every(p => PERMISSIONS.includes(p))) throw new Error('Provide a valid email and explicit, distinct permissions.');
  if (!db.prepare('SELECT id FROM departments WHERE id = ?').get(departmentId)) throw new Error('Department does not exist.');
  const passwordHash = await hashPassword(password);
  return transaction(db, () => {
    // Never reset, upsert, or silently grant privileges to an existing account.
    if (db.prepare('SELECT id FROM administrator_accounts WHERE email = ?').get(normalized)) throw new Error('Account already exists; no changes made.');
    const id = randomUUID();
    db.prepare('INSERT INTO administrator_accounts(id, email, password_hash) VALUES (?, ?, ?)').run(id, normalized, passwordHash);
    db.prepare('INSERT INTO department_memberships(department_id, administrator_id) VALUES (?, ?)').run(departmentId, id);
    for (const permission of permissions) {
      db.prepare('INSERT INTO membership_permissions(department_id, administrator_id, permission) VALUES (?, ?, ?)')
        .run(departmentId, id, permission);
    }
    audit(db, 'administrator_provisioned', id, departmentId);
    return { administratorId: id, departmentId, permissions: [...permissions] };
  });
}
