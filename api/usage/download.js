import { currentUser, sql, json, body } from '../_lib/core.js';
import { usageFor, monthKey, isUnlocked } from '../_lib/plan.js';

// PDFs (action plan, full summary) can be downloaded as often as needed once the report is unlocked
// (fp = the audit's file fingerprint). Previews can't be downloaded. Subscribers and team accounts are unlimited.
export async function takeDownload(user, kind, ref, fp) {
  const u = await usageFor(user);
  if (u.unlimited) return { ok: true, usage: u };
  if (!(await isUnlocked(user, fp))) return { ok: false, code: 'locked', usage: u };
  ref = typeof ref === 'string' ? ref.slice(0, 64) : '';
  const ins = await sql`insert into usage_downloads(user_id,month,kind,ref) values(${user.id},${monthKey()},${kind},${ref || null}) returning id`;
  return { ok: true, rowId: ins[0] && ins[0].id, usage: u };
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in to download reports.', code: 'signin' });
  const b = body(req), kind = b.kind === 'plan' ? 'plan' : 'summary';
  const r = await takeDownload(user, kind, b.ref, b.fp);
  return r.ok ? json(res, 200, { ok: true, again: !!r.again, usage: r.usage }) : json(res, 402, { error: 'locked', code: 'locked', kind, usage: r.usage });
}
