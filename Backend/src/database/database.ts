import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PROJECT_ROOT } from '../config.ts';

// Fixed backend-local location; deliberately unrelated to the active JSON index.
export const DATABASE_PATH = resolve(PROJECT_ROOT, 'data', 'student-os.sqlite');

export function openDatabase(path = DATABASE_PATH, readOnly = false): DatabaseSync {
  if (!readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { readOnly, enableForeignKeyConstraints: true, timeout: 5000 });
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;');
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('SQLite foreign keys must be enabled.');
    return db;
  } catch (error) { db.close(); throw error; }
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
