import { sql } from './core.js';
import { mailOn } from './mail.js';

// Free plan: one free audit per account, ever (FREE_REPORTS_PER_MONTH sets how many), with one download of each PDF.
// Paid plans and ADMIN_EMAILS are unlimited. Connecting ad accounts is a paid feature.
const TZ = 'Asia/Dubai';
const list = k => (process.env[k] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
export const freeLimit = () => Math.max(0, parseInt(process.env.FREE_REPORTS_PER_MONTH || '1', 10));
export const monthKey = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(d).slice(0, 7);
export const nextReset = (d = new Date()) => { const [y, m] = monthKey(d).split('-').map(Number); return new Date(Date.UTC(m === 12 ? y + 1 : y, m % 12, 1) - 4 * 3600e3).toISOString(); };
export const isAdmin = u => list('ADMIN_EMAILS').includes(String(u.email).toLowerCase());
// Email counts as confirmed when confirmed by link, when email isn't set up yet, or for invited early-access emails.
export const verified = u => !!u.email_verified_at || !mailOn() || list('ALLOWED_EMAILS').includes(String(u.email).toLowerCase());

export const canConnect = u => !!u && ((u.plan || 'free') !== 'free' || isAdmin(u));
export async function usageFor(u) {
  const plan = u.plan || 'free', unlimited = plan !== 'free' || isAdmin(u);
  // free audits and downloads are counted over the life of the account, not per month
  const used = (await sql`select count(distinct coalesce(fp, id::text))::int as n from usage_reports where user_id=${u.id}`)[0].n;
  const dl = await sql`select kind, count(*)::int as n from usage_downloads where user_id=${u.id} group by kind`;
  const downloads = { plan: 0, summary: 0 }; for (const r of dl) downloads[r.kind] = r.n;
  return { plan, unlimited, used, limit: unlimited ? null : freeLimit(), resets: null, once: !unlimited, verified: verified(u), downloads, dlLimit: unlimited ? null : 1, canConnect: canConnect(u) };
}
