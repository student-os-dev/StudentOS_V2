import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// OWASP's memory-conserving scrypt profile: 32 MiB, r=8, p=3.
const PARAMETERS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const FORMAT = /^\$scrypt\$N=32768,r=8,p=3\$([0-9a-f]{32})\$([0-9a-f]{64})$/;
const dummySalt = randomBytes(16);
const dummyKey = randomBytes(32);
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, PARAMETERS,
    (error, result) => error ? reject(error) : resolve(result)));
}
export function validPassword(password: unknown): password is string {
  return typeof password === 'string' && Array.from(password).length >= 15 &&
    Array.from(password).length <= 128 && Buffer.byteLength(password, 'utf8') <= 512;
}
export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}
export async function hashPassword(password: string): Promise<string> {
  if (!validPassword(password)) throw new Error('Use a password of 15 to 128 characters (at most 512 UTF-8 bytes).');
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return '$scrypt$N=32768,r=8,p=3$' + salt.toString('hex') + '$' + key.toString('hex');
}
export async function verifyPassword(password: string, encoded: unknown): Promise<boolean> {
  const match = typeof encoded === 'string' ? FORMAT.exec(encoded) : null;
  // Unknown, disabled, or unsupported hashes still perform the same expensive work.
  const derived = await derive(password, match ? Buffer.from(match[1]!, 'hex') : dummySalt);
  const equal = timingSafeEqual(derived, match ? Buffer.from(match[2]!, 'hex') : dummyKey);
  return match !== null && equal;
}
