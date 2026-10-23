import { currentUser, sql, json, body } from '../_lib/core.js';

// Updates one saved report: mark a finding done or not (k), switch the follow-up on or off, or delete it.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  const b = body(req), id = String(b.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: 'Unknown report.' });
  const r = await sql`select data,created_at from saved_reports where id=${id} and user_id=${user.id}`;
  if (!r[0]) return json(res, 404, { error: 'That report isn’t in your account.' });
  if (b.action === 'delete') { await sql`delete from saved_reports where id=${id} and user_id=${user.id}`; return json(res, 200, { ok: true }); }
  if (b.action === 'followup') {
    const at = b.on ? new Date(Math.max(Date.now() + 864e5, new Date(r[0].created_at).getTime() + 7 * 864e5)).toISOString() : null;
    await sql`update saved_reports set followup_at=${at}, followup_sent_at=null where id=${id} and user_id=${user.id}`;
    return json(res, 200, { ok: true, followup_at: at });
  }
  const d = r[0].data, f = (d.findings || []).find(x => x.k === String(b.k || ''));
  if (!f) return json(res, 404, { error: 'That action isn’t in this report.' });
  f.done = !!b.done; f.doneAt = f.done ? new Date().toISOString() : null;
  await sql`update saved_reports set data=${JSON.stringify(d)} where id=${id} and user_id=${user.id}`;
  return json(res, 200, { ok: true });
}
