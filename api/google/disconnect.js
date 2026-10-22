import { currentUser, sql, json, decrypt } from '../_lib/core.js';

// Revokes the Google grant and deletes the stored refresh token and account list.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  const r = await sql`select token_enc from google_connections where user_id=${user.id}`;
  if (r[0]) { try { await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: decrypt(r[0].token_enc) }) }); } catch {} }
  await sql`delete from google_ad_accounts where user_id=${user.id}`;
  await sql`delete from google_connections where user_id=${user.id}`;
  return json(res, 200, { ok: true });
}
