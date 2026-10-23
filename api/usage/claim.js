import { currentUser, sql, json, body } from '../_lib/core.js';
import { usageFor, monthKey } from '../_lib/plan.js';

// Called before an audit report is built. Counts one report per distinct set of files per month;
// re-opening the same files in the same month doesn't use another report.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in to run an audit.', code: 'signin' });
  const fp = String(body(req).fp || '').slice(0, 128) || null;
  const u = await usageFor(user);
  if (!u.verified) return json(res, 403, { error: 'Confirm your email to run your free report. We sent you a link when you signed up.', code: 'verify', usage: u });
  const month = monthKey();
  const seen = fp ? (await sql`select 1 from usage_reports where user_id=${user.id} and month=${month} and fp=${fp} limit 1`).length : 0;
  // Editing window: for 24 hours after a report, fixing files, adding platforms or re-running doesn't use another one.
  const recent = !seen ? (await sql`select 1 from usage_reports where user_id=${user.id} and at>now()-interval '24 hours' limit 1`).length : 0;
  if (!seen && recent) { if (fp) await sql`update usage_reports set fp=coalesce(fp,${fp}) where id=(select id from usage_reports where user_id=${user.id} order by at desc limit 1)`; return json(res, 200, { ok: true, window: true, usage: await usageFor(user) }); }
  if (!seen && !u.unlimited && u.used >= u.limit)
    return json(res, 402, { error: 'limit', code: 'limit', usage: u });
  if (!seen) await sql`insert into usage_reports(user_id,month,fp) values(${user.id},${month},${fp})`;
  return json(res, 200, { ok: true, usage: await usageFor(user) });
}
