import { currentUser, sql, json } from '../_lib/core.js';

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.', code: 'signin' });
  const id = new URL(req.url, 'https://optiroas.com').searchParams.get('id');
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) return json(res, 400, { error: 'Unknown report.' });
  const r = await sql`select id,data,created_at,followup_at,followup_sent_at from saved_reports where id=${id} and user_id=${user.id}`;
  if (!r[0]) return json(res, 404, { error: 'That report isn’t in your account.' });
  return json(res, 200, { report: r[0] });
}
