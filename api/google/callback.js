import { currentUser, cookies, setCookie, sql, encrypt, logApi } from '../_lib/core.js';
import { tokenRequest, discover } from '../_lib/google.js';

const back = (res, q) => { res.statusCode = 302; res.setHeader('Location', `/?${q}#account`); res.end(); };
const emailFromIdToken = t => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString()).email || null; } catch { return null; } };

export default async function handler(req, res) {
  const p = Object.fromEntries(new URL(req.url, 'https://optiroas.com').searchParams);
  const user = await currentUser(req);
  const [state, uid] = String(cookies(req).or_g_state || '').split('.');
  setCookie(res, 'or_g_state', '', 0);
  if (!user) return back(res, 'google=signin');
  if (p.error) return back(res, 'google=cancelled');
  if (!p.code || p.state !== state || uid !== user.id) return back(res, 'google=error&why=state');
  try {
    const tok = await tokenRequest({ grant_type: 'authorization_code', code: p.code, redirect_uri: process.env.GOOGLE_REDIRECT_URI });
    if (!tok.refresh_token) throw new Error('Google did not return offline access. Remove OptiROAS from your Google account permissions and connect again.');
    if (!String(tok.scope || '').includes('adwords')) throw new Error('Google Ads access was not granted. Tick the Google Ads permission when connecting.');
    const access = tok.access_token, email = emailFromIdToken(tok.id_token);
    const { accts, note } = await discover(access, (e, ok) => logApi(user.id, e, ok));
    await sql`insert into google_connections(user_id,google_email,token_enc,note) values(${user.id},${email},${encrypt(tok.refresh_token)},${note})
      on conflict(user_id) do update set google_email=excluded.google_email,token_enc=excluded.token_enc,note=excluded.note,updated_at=now()`;
    await sql`delete from google_ad_accounts where user_id=${user.id}`;
    for (const a of accts)
      await sql`insert into google_ad_accounts(user_id,customer_id,name,currency,timezone,login_customer_id) values(${user.id},${a.id},${a.name || 'Account ' + a.id},${a.currency || null},${a.tz || null},${a.login})`;
    return back(res, `google=connected&n=${accts.length}`);
  } catch (e) {
    console.error('google callback', e.message, e.code);
    return back(res, 'google=error&why=' + encodeURIComponent(String(e.message).slice(0, 160)));
  }
}
