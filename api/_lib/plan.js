import { sql } from './core.js';
import { mailOn } from './mail.js';

// Free plan: FREE_REPORTS_PER_MONTH audit reports per calendar month (UAE time). Paid plans and ADMIN_EMAILS are unlimited.
const TZ = 'Asia/Dubai';
const list = k => (process.env[k] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
export const freeLimit = () => Math.max(0, parseInt(process.env.FREE_REPORTS_PER_MONTH || '1', 10));
export const monthKey = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(d).slice(0, 7);
export const nextReset = (d = new Date()) => { const [y, m] = monthKey(d).split('-').map(Number); return new Date(Date.UTC(m === 12 ? y + 1 : y, m % 12, 1) - 4 * 3600e3).toISOString(); };
export const isAdmin = u => list('ADMIN_EMAILS').includes(String(u.email).toLowerCase());
// Email counts as confirmed when confirmed by link, when email isn't set up yet, or for invited early-access emails.
export const verified = u => !!u.email_verified_at || !mailOn() || list('ALLOWED_EMAILS').includes(String(u.email).toLowerCase());

export async function usageFor(u) {
  const plan = u.plan || 'free', unlimited = plan !== 'free' || isAdmin(u);
  const used = (await sql`select count(distinct coalesce(fp, id::text))::int as n from usage_reports where user_id=${u.id} and month=${monthKey()}`)[0].n;
  return { plan, unlimited, used, limit: unlimited ? null : freeLimit(), resets: nextReset(), verified: verified(u) };
}
