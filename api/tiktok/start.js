import crypto from 'node:crypto';
import { currentUser, setCookie, json } from '../_lib/core.js';
import { canConnect } from '../_lib/plan.js';

// Sends the signed-in user to TikTok's advertiser authorization page.
export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) { res.statusCode = 302; res.setHeader('Location', '/?tiktok=signin#account'); return res.end(); }
  if (!canConnect(user)) { res.statusCode = 302; res.setHeader('Location', '/?upgrade=connect#pricing'); return res.end(); }
  const { TIKTOK_APP_ID, TIKTOK_REDIRECT_URI } = process.env;
  if (!TIKTOK_APP_ID || !TIKTOK_REDIRECT_URI || !process.env.TIKTOK_APP_SECRET) return json(res, 500, { error: 'TikTok connection is not configured yet.' });
  const state = crypto.randomBytes(24).toString('base64url');
  setCookie(res, 'or_t_state', `${state}.${user.id}`, 600);
  const u = new URL('https://business-api.tiktok.com/portal/auth');
  u.search = new URLSearchParams({ app_id: TIKTOK_APP_ID, state, redirect_uri: TIKTOK_REDIRECT_URI }).toString();
  res.statusCode = 302; res.setHeader('Location', u.toString()); res.end();
}
