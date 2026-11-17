export interface AdminConfig {
  origins: string[];
  secureCookies: boolean;
  trustLoopbackProxy: boolean;
  cookieName: string;
  absoluteMs: number;
  idleMs: number;
  rateWindowMs: number;
  accountAttempts: number;
  ipAttempts: number;
}
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const production = env.NODE_ENV === 'production';
  const configured = env.ADMIN_ORIGINS?.trim();
  if (production && !configured) throw new Error('Production requires explicit HTTPS ADMIN_ORIGINS.');
  const origins = (configured ?? 'http://127.0.0.1:3000,http://localhost:3000').split(',').map(value => {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('ADMIN_ORIGINS must contain exact HTTP(S) origins.');
    if (url.protocol === 'http:' && (production || !localHosts.has(url.hostname))) {
      throw new Error('HTTP administrator access is only allowed on localhost in development.');
    }
    return url.origin;
  });
  if (new Set(origins.map(origin => new URL(origin).protocol)).size !== 1) throw new Error('Do not mix HTTP and HTTPS administrator origins.');
  const secureCookies = origins.every(origin => origin.startsWith('https:'));
  if (!secureCookies && !localHosts.has(env.HOST?.trim() ?? '127.0.0.1')) {
    throw new Error('HTTP administrator development requires a loopback HOST.');
  }
  return {
    origins, secureCookies, trustLoopbackProxy: env.ADMIN_TRUST_LOOPBACK_PROXY === '1', cookieName: secureCookies ? '__Host-student_os_admin' : 'student_os_admin_dev',
    absoluteMs: 8 * 60 * 60 * 1000, idleMs: 30 * 60 * 1000,
    rateWindowMs: 15 * 60 * 1000, accountAttempts: 5, ipAttempts: 30,
  };
}
