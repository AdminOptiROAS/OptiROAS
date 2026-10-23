import { currentUser, sql, json, body } from '../_lib/core.js';
import { usageFor, monthKey } from '../_lib/plan.js';

// Free plan: each PDF type (action plan, full summary) can be downloaded once per calendar month.
// Paid plans and team accounts are unlimited. Called just before the PDF is produced.
export async function takeDownload(user, kind) {
  const u = await usageFor(user);
  if (u.unlimited) return { ok: true, usage: u };
  if ((u.downloads[kind] || 0) >= u.dlLimit) return { ok: false, usage: u };
  await sql`insert into usage_downloads(user_id,month,kind) values(${user.id},${monthKey()},${kind})`;
  return { ok: true, usage: await usageFor(user) };
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in to download reports.', code: 'signin' });
  const kind = body(req).kind === 'plan' ? 'plan' : 'summary';
  const r = await takeDownload(user, kind);
  return r.ok ? json(res, 200, { ok: true, usage: r.usage }) : json(res, 402, { error: 'dl_limit', code: 'dl_limit', kind, usage: r.usage });
}
