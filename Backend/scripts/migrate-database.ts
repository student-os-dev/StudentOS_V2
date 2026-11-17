import { DATABASE_PATH, openDatabase } from '../src/database/database.ts';
import { migrate } from '../src/database/migrate.ts';

try {
  const db = openDatabase();
  try { console.log(JSON.stringify({ databasePath: DATABASE_PATH, ...migrate(db) }, null, 2)); }
  finally { db.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
