import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.ts';
import { foundationSql } from './migrations/001-foundation.ts';

import { administratorAuthSql } from './migrations/002-administrator-auth.ts';

import { transportKnowledgeSql } from './migrations/003-transport-knowledge.ts';

export interface Migration { version: number; name: string; sql: string }
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'database-foundation', sql: foundationSql },
  { version: 2, name: 'administrator-authentication', sql: administratorAuthSql },
  { version: 3, name: 'transport-knowledge-management', sql: transportKnowledgeSql },
];
function checksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql).digest('hex');
}

export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS) {
  for (const [position, migration] of migrations.entries()) {
    if (migration.version !== position + 1 || !migration.name.trim() || !migration.sql.trim()) {
      throw new Error('Migrations must be nonempty and sequential, starting at version 1.');
    }
  }
  return transaction(db, () => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (' +
      'version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, ' +
      "applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) STRICT");
    const existing = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
    for (const [position, row] of existing.entries()) {
      const expected = migrations[position];
      if (!expected || row.version !== expected.version || row.name !== expected.name || row.checksum !== checksum(expected)) {
        throw new Error('Migration history differs from this application. Restore matching migration files; do not rewrite applied migrations.');
      }
    }
    const applied: number[] = [];
    for (const migration of migrations.slice(existing.length)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version, name, checksum) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, checksum(migration));
      applied.push(migration.version);
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database contains foreign-key violations.');
    return { applied, currentVersion: migrations.length };
  });
}
