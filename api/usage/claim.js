import { currentUser, sql, json, body } from '../_lib/core.js';
import { usageFor, monthKey, isUnlocked } from '../_lib/plan.js';

// Called when a signed-in user runs an audit. Everyone can run audits and see the preview;
// the response says whether this report (fp, a hash of its files) is unlocked in full.
// Starter/Pro and team accounts are always unlocked; Audit plan subscribers use one of their monthly audits. Running the same files again isn't logged twice.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in to run an audit.', code: 'signin' });
  const fp = String(body(req).fp || '').slice(0, 128) || null;
  const u = await usageFor(user);
  if (!u.verified) return json(res, 403, { error: 'Confirm your email to run your report. We sent you a link when you signed up.', code: 'verify', usage: u });
  const seen = fp ? (await sql`select 1 from usage_reports where user_id=${user.id} and fp=${fp} limit 1`).length : 0;
  if (!seen) await sql`insert into usage_reports(user_id,month,fp) values(${user.id},${monthKey()},${fp})`;
  let unlocked = u.unlimited || await isUnlocked(user, fp);
  if (!unlocked && fp && u.monthly && u.monthly.left > 0) {
    await sql`insert into audit_unlocks(user_id, fp) values(${user.id}, ${fp}) on conflict do nothing`;
    unlocked = true;
  }
  return json(res, 200, { ok: true, unlocked, usage: await usageFor(user) });
}
