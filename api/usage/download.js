import { currentUser, sql, json, body } from '../_lib/core.js';
import { usageFor, monthKey } from '../_lib/plan.js';

// Free plan: each PDF type (action plan, full summary) can be downloaded once, for the one free audit.
// Paid plans and team accounts are unlimited. Called just before the PDF is produced.
// `ref` identifies the report (a hash of its files). Downloading the same report again in the same month is free,
// so a cancelled print dialog or a lost file never costs the allowance.
export async function takeDownload(user, kind, ref) {
  const u = await usageFor(user);
  if (u.unlimited) return { ok: true, usage: u };
  ref = typeof ref === 'string' ? ref.slice(0, 64) : '';
  if (ref) {
    const seen = await sql`select 1 from usage_downloads where user_id=${user.id} and kind=${kind} and ref=${ref} limit 1`;
    if (seen.length) return { ok: true, again: true, usage: u };
  }
  if ((u.downloads[kind] || 0) >= u.dlLimit) return { ok: false, usage: u };
  const ins = await sql`insert into usage_downloads(user_id,month,kind,ref) values(${user.id},${monthKey()},${kind},${ref || null}) returning id`;
  return { ok: true, rowId: ins[0] && ins[0].id, usage: await usageFor(user) };
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in to download reports.', code: 'signin' });
  const b = body(req), kind = b.kind === 'plan' ? 'plan' : 'summary';
  const r = await takeDownload(user, kind, b.ref);
  return r.ok ? json(res, 200, { ok: true, again: !!r.again, usage: r.usage }) : json(res, 402, { error: 'dl_limit', code: 'dl_limit', kind, usage: r.usage });
}
