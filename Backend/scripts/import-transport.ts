import { loadDataset } from '../src/knowledge.ts';
import { DATABASE_PATH, openDatabase } from '../src/database/database.ts';
import { migrate } from '../src/database/migrate.ts';
import { importTransport } from '../src/database/import-transport.ts';

try {
  const dataset = await loadDataset();
  const db = openDatabase();
  try {
    const migrations = migrate(db);
    console.log(JSON.stringify({ databasePath: DATABASE_PATH, migrations, ...importTransport(db, dataset) }, null, 2));
  } finally { db.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
