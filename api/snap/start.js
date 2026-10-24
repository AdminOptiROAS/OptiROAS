import crypto from 'node:crypto';
import { currentUser, setCookie, json } from '../_lib/core.js';
import { SNAP_SCOPE } from '../_lib/snap.js';
import { canConnect } from '../_lib/plan.js';

// Sends the signed-in user to Snapchat's consent screen (Marketing API scope; OptiROAS only reads).
export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) { res.statusCode = 302; res.setHeader('Location', '/?snap=signin#account'); return res.end(); }
  if (!canConnect(user)) { res.statusCode = 302; res.setHeader('Location', '/?upgrade=connect#pricing'); return res.end(); }
  const { SNAP_CLIENT_ID, SNAP_REDIRECT_URI } = process.env;
  if (!SNAP_CLIENT_ID || !SNAP_REDIRECT_URI || !process.env.SNAP_CLIENT_SECRET) return json(res, 500, { error: 'Snapchat connection is not configured yet.' });
  const state = crypto.randomBytes(24).toString('base64url');
  setCookie(res, 'or_s_state', `${state}.${user.id}`, 600);
  const u = new URL('https://accounts.snapchat.com/login/oauth2/authorize');
  u.search = new URLSearchParams({ client_id: SNAP_CLIENT_ID, redirect_uri: SNAP_REDIRECT_URI, response_type: 'code', scope: SNAP_SCOPE, state }).toString();
  res.statusCode = 302; res.setHeader('Location', u.toString()); res.end();
}
