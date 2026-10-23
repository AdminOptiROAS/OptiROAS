import { ensureSchema, sql, json, body, hashPassword, startSession } from '../_lib/core.js';
import { useToken } from '../_lib/tokens.js';

// Sets a new password from a reset link, signs out every other device and signs this one in.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const { token, password } = body(req);
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) return json(res, 400, { error: 'Use a password of at least 8 characters.' });
  await ensureSchema();
  const uid = await useToken(token, 'reset');
  if (!uid) return json(res, 400, { error: 'This reset link has expired or was already used. Ask for a new one.', code: 'expired' });
  await sql`update users set pass_hash=${hashPassword(password)}, email_verified_at=coalesce(email_verified_at, now()) where id=${uid}`;
  await sql`delete from sessions where user_id=${uid}`;
  await startSession(res, uid);
  const r = await sql`select id,email,name from users where id=${uid}`;
  return json(res, 200, { user: r[0] });
}
