import { ensureSchema, sql, json, body, checkPassword, startSession } from '../_lib/core.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const { email: e, password } = body(req);
  const email = String(e || '').trim().toLowerCase();
  await ensureSchema();
  const r = await sql`select id,email,name,pass_hash from users where email=${email}`;
  if (!r[0] || typeof password !== 'string' || !checkPassword(password, r[0].pass_hash))
    return json(res, 401, { error: 'That email and password don’t match.' });
  await startSession(res, r[0].id);
  return json(res, 200, { user: { id: r[0].id, email: r[0].email, name: r[0].name } });
}
