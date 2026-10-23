import { currentUser, sql, json, decrypt, logApi } from '../_lib/core.js';
import { accessFromRefresh, discover } from '../_lib/google.js';

// Re-reads the Google Ads accounts for the stored Google login (e.g. after someone grants this email access).
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  const con = await sql`select token_enc from google_connections where user_id=${user.id}`;
  if (!con[0]) return json(res, 409, { error: 'Connect Google Ads first.' });
  try {
    const access = await accessFromRefresh(decrypt(con[0].token_enc));
    const { accts, note } = await discover(access, (e, ok) => logApi(user.id, e, ok));
    await sql`update google_connections set note=${note}, updated_at=now() where user_id=${user.id}`;
    await sql`delete from google_ad_accounts where user_id=${user.id}`;
    for (const a of accts)
      await sql`insert into google_ad_accounts(user_id,customer_id,name,currency,timezone,login_customer_id) values(${user.id},${a.id},${a.name || 'Account ' + a.id},${a.currency || null},${a.tz || null},${a.login})`;
    return json(res, 200, { ok: true, n: accts.length, note });
  } catch (e) {
    const expired = e.code === 'invalid_grant';
    return json(res, expired ? 409 : 502, { error: expired ? 'Your Google connection has expired. Reconnect Google Ads.' : `Google Ads: ${e.message}` });
  }
}
