// Snapchat Marketing API helpers: OAuth and read-only GET requests.
import { sql, encrypt, decrypt } from './core.js';
export const SNAP_API = 'https://adsapi.snapchat.com/v1';
export const SNAP_SCOPE = 'snapchat-marketing-api';

export async function snapToken(params) {
  const r = await fetch('https://accounts.snapchat.com/login/oauth2/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.SNAP_CLIENT_ID, client_secret: process.env.SNAP_CLIENT_SECRET, ...params })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { const e = new Error(j.error_description || j.error || `Snapchat returned ${r.status}`); e.code = j.error; throw e; }
  return j;
}

export async function snapGet(access, path, params) {
  let url = path.startsWith('http') ? path : `${SNAP_API}${path}${params ? '?' + new URLSearchParams(params) : ''}`;
  const out = [];
  for (let page = 0; page < 20 && url; page++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j.request_status && j.request_status !== 'SUCCESS')) {
      const e = new Error(j.display_message || j.debug_message || j.error || `Snapchat returned ${r.status}`); e.status = r.status; throw e;
    }
    out.push(j);
    url = j.paging && j.paging.next_link;
  }
  return out;
}

// UTC offset (e.g. "+04:00") of an IANA time zone on a given day, for Snapchat's day boundaries.
export function tzOffset(tz, date) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', timeZoneName: 'longOffset' }).formatToParts(date).find(x => x.type === 'timeZoneName');
    const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(p && p.value || '');
    return m ? `${m[1]}:${m[2] || '00'}` : '+00:00';
  } catch { return '+00:00'; }
}

// A fresh access token for a user's Snapchat connection. Two pulls can run at once (campaign list and report),
// and Snapchat may rotate the refresh token: save a new one only if the stored one is still the one we used,
// and if our refresh fails because another request already rotated it, retry once with the newer token.
export async function snapAccess(userId) {
  for (let i = 0; i < 2; i++) {
    const row = (await sql`select token_enc from snap_connections where user_id=${userId}`)[0];
    if (!row) { const e = new Error('Connect Snapchat first.'); e.status = 409; throw e; }
    try {
      const tok = await snapToken({ grant_type: 'refresh_token', refresh_token: decrypt(row.token_enc) });
      if (tok.refresh_token) await sql`update snap_connections set token_enc=${encrypt(tok.refresh_token)}, updated_at=now() where user_id=${userId} and token_enc=${row.token_enc}`;
      return tok.access_token;
    } catch (e) {
      await new Promise(r => setTimeout(r, 600)); // let a parallel refresh finish saving its new token
      const now = (await sql`select token_enc from snap_connections where user_id=${userId}`)[0];
      if (i === 0 && now && now.token_enc !== row.token_enc) continue;
      if (e.code === 'invalid_grant') { e.message = 'Your Snapchat connection has expired. Reconnect Snapchat.'; e.status = 401; }
      throw e;
    }
  }
}
