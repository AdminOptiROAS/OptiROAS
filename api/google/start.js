import crypto from 'node:crypto';
import { currentUser, setCookie, json } from '../_lib/core.js';
import { SCOPE } from '../_lib/google.js';
import { canConnect } from '../_lib/plan.js';

// Sends the signed-in user to Google's consent screen (read access to Google Ads via the adwords scope).
export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) { res.statusCode = 302; res.setHeader('Location', '/?google=signin#account'); return res.end(); }
  if (!canConnect(user)) { res.statusCode = 302; res.setHeader('Location', '/?upgrade=connect#pricing'); return res.end(); }
  const { GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI || !process.env.GOOGLE_CLIENT_SECRET) return json(res, 500, { error: 'Google connection is not configured yet.' });
  const state = crypto.randomBytes(24).toString('base64url');
  setCookie(res, 'or_g_state', `${state}.${user.id}`, 600);
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT_URI, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, login_hint: user.email
  }).toString();
  res.statusCode = 302; res.setHeader('Location', u.toString()); res.end();
}
