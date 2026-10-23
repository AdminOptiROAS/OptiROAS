import { currentUser, sql, json } from '../_lib/core.js';

// Deletes the stored Snapchat refresh token and ad account list.
// (Users can also remove OptiROAS under Snapchat account settings → Connected apps.)
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  await sql`delete from snap_ad_accounts where user_id=${user.id}`;
  await sql`delete from snap_connections where user_id=${user.id}`;
  return json(res, 200, { ok: true });
}
