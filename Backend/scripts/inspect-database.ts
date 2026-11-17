import { DATABASE_PATH, openDatabase } from '../src/database/database.ts';

// Read-only: does not initialize, migrate, repair, or create a missing database.
try {
  const db = openDatabase(DATABASE_PATH, true);
  try {
    const tables = ['departments', 'administrator_accounts', 'department_memberships', 'membership_permissions',
      'documents', 'document_versions', 'version_reviews', 'knowledge_chunks', 'indexing_metadata', 'publication_pointers', 'audit_events', 'administrator_sessions', 'login_rate_limits'];
    console.log(JSON.stringify({
      databasePath: DATABASE_PATH,
      foreignKeys: db.prepare('PRAGMA foreign_keys').get()?.foreign_keys,
      integrity: db.prepare('PRAGMA integrity_check').all(),
      foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all(),
      migrations: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
      counts: Object.fromEntries(tables.map(table => [table, db.prepare('SELECT count(*) AS count FROM ' + table).get()?.count])),
      versions: db.prepare('SELECT v.id, v.document_id, v.version_number, v.title, r.status FROM document_versions v ' +
        'LEFT JOIN version_reviews r ON r.version_id = v.id ORDER BY v.document_id, v.version_number').all(),
    }, null, 2));
  } finally { db.close(); }
} catch (error) {
  console.error('Database inspection failed. Initialize with npm run db:migrate first. ' +
    (error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
