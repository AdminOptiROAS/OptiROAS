import { currentUser, sql, json, body } from '../_lib/core.js';
import { cleanSummary } from '../_lib/report.js';

// Saves a report summary (no files, no rows) to the signed-in account. Optional 7-day follow-up.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in to save reports to your account.', code: 'signin' });
  const b = body(req), d = cleanSummary(b.data);
  if (!d.findings.length && d.score == null && !(+d.total > 0)) return json(res, 400, { error: 'Nothing to save.' });
  if (JSON.stringify(d).length > 250000) return json(res, 413, { error: 'This report is too large to save.' });
  const n = (await sql`select count(*)::int as n from saved_reports where user_id=${user.id}`)[0].n;
  if (n >= 100) return json(res, 409, { error: 'You have 100 saved reports. Delete some older ones to save more.' });
  const r = await sql`insert into saved_reports(user_id,label,period,currency,score,data,lang,followup_at)
    values(${user.id},${d.label},${d.period},${d.cur},${d.score},${JSON.stringify(d)},${d.lang},${b.followup ? new Date(Date.now() + 7 * 864e5).toISOString() : null}) returning id, created_at`;
  return json(res, 200, { ok: true, id: r[0].id, created_at: r[0].created_at });
}
