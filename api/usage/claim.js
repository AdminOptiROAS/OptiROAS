import { currentUser, sql, json, body } from '../_lib/core.js';
import { usageFor, monthKey } from '../_lib/plan.js';

// Called when the user confirms an audit. Free plan: one confirmed audit per account;
// re-opening exactly the same files doesn't use another one.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in to run an audit.', code: 'signin' });
  const fp = String(body(req).fp || '').slice(0, 128) || null;
  const u = await usageFor(user);
  if (!u.verified) return json(res, 403, { error: 'Confirm your email to run your free report. We sent you a link when you signed up.', code: 'verify', usage: u });
  const month = monthKey();
  const seen = fp ? (await sql`select 1 from usage_reports where user_id=${user.id} and fp=${fp} limit 1`).length : 0;
  if (!seen && !u.unlimited && u.used >= u.limit)
    return json(res, 402, { error: 'limit', code: 'limit', usage: u });
  if (!seen) await sql`insert into usage_reports(user_id,month,fp) values(${user.id},${month},${fp})`;
  return json(res, 200, { ok: true, usage: await usageFor(user) });
}
