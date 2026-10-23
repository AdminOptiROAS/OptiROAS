import { currentUser, sql, json } from '../_lib/core.js';
import { tokenFor, ttPost } from '../_lib/tiktok.js';

// Revokes OptiROAS's TikTok access (best effort) and deletes the stored token and account list.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  try { const t = await tokenFor(user.id); if (t) await ttPost('/oauth2/revoke_token/', { app_id: process.env.TIKTOK_APP_ID, secret: process.env.TIKTOK_APP_SECRET, access_token: t }); } catch {}
  await sql`delete from tiktok_ad_accounts where user_id=${user.id}`;
  await sql`delete from tiktok_connections where user_id=${user.id}`;
  return json(res, 200, { ok: true });
}
