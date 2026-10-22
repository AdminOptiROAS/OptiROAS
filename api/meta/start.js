import crypto from 'node:crypto';
import { currentUser, setCookie, json } from '../_lib/core.js';

// Sends the signed-in user to Facebook Login for Business (read-only ads_read configuration).
export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) { res.statusCode = 302; res.setHeader('Location', '/?meta=signin#audit'); return res.end(); }
  const { META_APP_ID, META_LOGIN_CONFIG_ID, META_REDIRECT_URI, META_GRAPH_VERSION } = process.env;
  if (!META_APP_ID || !META_LOGIN_CONFIG_ID || !META_REDIRECT_URI) return json(res, 500, { error: 'Meta connection is not configured.' });
  const state = crypto.randomBytes(24).toString('base64url');
  setCookie(res, 'or_meta_state', `${state}.${user.id}`, 600);
  const u = new URL(`https://www.facebook.com/${META_GRAPH_VERSION || 'v26.0'}/dialog/oauth`);
  u.search = new URLSearchParams({
    client_id: META_APP_ID, redirect_uri: META_REDIRECT_URI, config_id: META_LOGIN_CONFIG_ID,
    response_type: 'code', override_default_response_type: 'true', state
  }).toString();
  res.statusCode = 302; res.setHeader('Location', u.toString()); res.end();
}
