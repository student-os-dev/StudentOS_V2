import { emitKeypressEvents } from 'node:readline';
import { openDatabase } from '../src/database/database.ts';
import { MIGRATIONS } from '../src/database/migrate.ts';
import { provisionAdministrator, PERMISSIONS, type Permission } from '../src/admin/provision.ts';

function hiddenPassword(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Provisioning requires an interactive terminal; passwords cannot be piped or passed as arguments.');
  process.stdout.write(label);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let password = '';
    const cleanup = () => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && ['c', 'd'].includes(key.name ?? '')) { cleanup(); reject(new Error('Provisioning cancelled.')); }
      else if (key.name === 'return' || key.name === 'enter') { cleanup(); resolve(password); }
      else if (key.name === 'backspace') password = Array.from(password).slice(0, -1).join('');
      else if (!key.ctrl && !key.meta && text && !/[\u0000-\u001f\u007f]/.test(text)) {
        if (Buffer.byteLength(password + text, 'utf8') > 512) { cleanup(); reject(new Error('Password exceeds 512 UTF-8 bytes.')); }
        else password += text;
      }
    };
    process.stdin.on('keypress', onKey);
  });
}
try {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!['--email', '--department', '--permissions'].includes(key) || !value || value.startsWith('--') || values.has(key)) {
      throw new Error('Usage: npm run admin:provision -- --email <email> --department <id> --permissions <edit,publish,...>. Password arguments are forbidden.');
    }
    values.set(key, value);
  }
  if (values.size !== 3) throw new Error('Explicit --email, --department and --permissions are required.');
  const permissions = values.get('--permissions')!.split(',');
  if (!permissions.every(p => PERMISSIONS.includes(p as Permission))) throw new Error('Permissions: edit, review, publish, archive.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use an interactive terminal. No account was created.');
  const db = openDatabase();
  try {
    if (db.prepare('SELECT max(version) AS version FROM schema_migrations').get()?.version !== MIGRATIONS.length) {
      throw new Error('Run npm run db:migrate first.');
    }
    let password = await hiddenPassword('New password (15?128 characters; input hidden): ');
    let confirmation = await hiddenPassword('Confirm password (input hidden): ');
    try {
      if (password !== confirmation) throw new Error('Passwords do not match; no account was created.');
      const result = await provisionAdministrator(db, values.get('--email')!, password, values.get('--department')!, permissions as Permission[]);
      console.log(JSON.stringify(result, null, 2));
    } finally { password = ''; confirmation = ''; }
  } finally { db.close(); }
} catch (error) {
  // Do not print raw database exceptions or supplied arguments.
  console.error(error instanceof Error && !('code' in error) ? error.message : 'Provisioning failed; no account was created.');
  process.exitCode = 1;
}
