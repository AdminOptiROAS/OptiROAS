import { sql } from './core.js';
import { mailOn } from './mail.js';

// Anyone signed in can run an audit and see a preview (score, vitals, top findings).
// The Audit plan (AED 55 a month, plan 'audit') unlocks AUDITS_PER_MONTH full reports per billing period.
// One-time audit credits (users.audit_credits) also unlock one report each, if ever sold.
// A report is identified by its files' fingerprint (fp); an unlocked fp stays unlocked (audit_unlocks).
// Subscriptions (Starter, Pro), ADMIN_EMAILS and REVIEW_EMAILS are unlimited. Connecting ad accounts is a subscription feature.
const TZ = 'Asia/Dubai';
const list = k => (process.env[k] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
export const freeLimit = () => Math.max(0, parseInt(process.env.FREE_REPORTS_PER_MONTH || '1', 10));
export const monthKey = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(d).slice(0, 7);
export const nextReset = (d = new Date()) => { const [y, m] = monthKey(d).split('-').map(Number); return new Date(Date.UTC(m === 12 ? y + 1 : y, m % 12, 1) - 4 * 3600e3).toISOString(); };
export const isAdmin = u => list('ADMIN_EMAILS').includes(String(u.email).toLowerCase());
// Platform reviewers (Meta, Google, TikTok): full access without paying or confirming email, never admin.
export const isReviewer = u => list('REVIEW_EMAILS').includes(String(u.email).toLowerCase());
// Email counts as confirmed when confirmed by link, when email isn't set up yet, or for invited early-access emails.
export const verified = u => !!u.email_verified_at || !mailOn() || list('ALLOWED_EMAILS').includes(String(u.email).toLowerCase()) || isReviewer(u);

// One definition of what each plan includes. The pricing page, account screen, audit limits, connections,
// downloads, calculator and live dashboard all read these (the browser receives them as usage.rules).
export const PLAN_RULES = {
  free: { audits: 1, downloadsEach: 1, connect: false, platforms: 0, calculator: false, live: false },
  audit: { audits: 3, downloadsEach: null, connect: false, platforms: 0, calculator: false, live: false },
  starter: { audits: null, downloadsEach: null, connect: true, platforms: 3, calculator: true, live: false },
  pro: { audits: null, downloadsEach: null, connect: true, platforms: 7, calculator: true, live: true }
};
export const rulesFor = u => {
  if (u && (isAdmin(u) || isReviewer(u))) return { ...PLAN_RULES.pro, platforms: 7, full: true };
  const pl = (u && u.plan) || 'free';
  // a paid plan whose Stripe product isn't recognised yet ('paid') gets Starter rules, never the free ones
  const r = PLAN_RULES[pl] || (pl === 'free' ? PLAN_RULES.free : PLAN_RULES.starter);
  if (pl === 'audit') return { ...r, audits: auditsPerMonth() };
  return r.audits === 1 ? { ...r, audits: freeLimit() } : { ...r };
};
const PLATS = ['meta', 'google', 'snap', 'tiktok'];
export async function connectedPlatforms(userId) {
  const r = await sql`select 'meta' k from meta_connections where user_id=${userId} union all select 'google' from google_connections where user_id=${userId}
    union all select 'snap' from snap_connections where user_id=${userId} union all select 'tiktok' from tiktok_connections where user_id=${userId}`;
  return PLATS.filter(k => r.some(x => x.k === k));
}
// Whether this user may start connecting `plat`: a reconnect is always fine; a new platform must fit the plan.
export async function connectCheck(u, plat) {
  if (!canConnect(u)) return { ok: false, to: '/?upgrade=connect#pricing' };
  const on = await connectedPlatforms(u.id);
  if (on.includes(plat) || on.length < rulesFor(u).platforms) return { ok: true };
  return { ok: false, to: '/?upgrade=platforms#pricing' };
}
// Subscriptions that are unlimited and can connect ad accounts. 'paid' = a subscription whose product isn't recognised yet.
const FULL = new Set(['starter', 'pro', 'paid']);
export const auditsPerMonth = () => Math.max(0, parseInt(process.env.AUDITS_PER_MONTH || '3', 10));
export const canConnect = u => !!u && (FULL.has(u.plan || 'free') || isAdmin(u) || isReviewer(u));
export async function isUnlocked(u, fp) {
  if (!fp) return false;
  return (await sql`select 1 from audit_unlocks where user_id=${u.id} and fp=${String(fp).slice(0, 128)} limit 1`).length > 0;
}
export async function usageFor(u) {
  const plan = u.plan || 'free', unlimited = FULL.has(plan) || isAdmin(u) || isReviewer(u);
  const row = (await sql`select audit_credits, period_start, period_end from users where id=${u.id}`)[0] || {};
  const unlocked = (await sql`select count(*)::int as n from audit_unlocks where user_id=${u.id}`)[0].n;
  // Audit plan: full audits left in the current billing period
  let monthly = null;
  if (plan === 'audit') {
    const from = row.period_start || new Date(Date.now() - 30 * 864e5);
    const n = (await sql`select count(*)::int as n from audit_unlocks where user_id=${u.id} and at >= ${from}`)[0].n;
    monthly = { limit: auditsPerMonth(), used: n, left: Math.max(0, auditsPerMonth() - n), renews: row.period_end || null };
  }
  const credits = (row.audit_credits || 0) + (monthly ? monthly.left : 0);
  // free audits and downloads are counted over the life of the account, not per month
  const used = (await sql`select count(distinct coalesce(fp, id::text))::int as n from usage_reports where user_id=${u.id}`)[0].n;
  const dl = await sql`select kind, count(*)::int as n from usage_downloads where user_id=${u.id} group by kind`;
  const downloads = { plan: 0, summary: 0 }; for (const r of dl) downloads[r.kind] = r.n;
  return { plan, unlimited, used, limit: null, resets: null, once: false, payPerAudit: !unlimited, credits, oneTime: row.audit_credits || 0, monthly, unlocked, verified: verified(u), downloads, dlLimit: null, canConnect: canConnect(u), live: rulesFor(u).live, rules: rulesFor(u), connected: await connectedPlatforms(u.id) };
}
