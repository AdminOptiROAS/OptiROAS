import { currentUser, sql, json, body } from '../_lib/core.js';
import { usageFor, isUnlocked } from '../_lib/plan.js';

// Unlocks the full report for one audit (fp) using one audit credit ($14.99 one-time payment).
// Unlocking a report that is already unlocked never uses another credit.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in to unlock your audit.', code: 'signin' });
  const fp = String(body(req).fp || '').slice(0, 128);
  if (!fp) return json(res, 400, { error: 'Run the audit first, then unlock it.' });
  let u = await usageFor(user);
  if (u.unlimited || await isUnlocked(user, fp)) return json(res, 200, { ok: true, unlocked: true, usage: u });
  const r = await sql`update users set audit_credits = audit_credits - 1 where id=${user.id} and audit_credits > 0 returning audit_credits`;
  if (!r.length) return json(res, 402, { error: 'no_credit', code: 'no_credit', usage: u });
  await sql`insert into audit_unlocks(user_id, fp) values(${user.id}, ${fp}) on conflict do nothing`;
  return json(res, 200, { ok: true, unlocked: true, usage: await usageFor(user) });
}
