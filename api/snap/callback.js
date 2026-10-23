import { currentUser, cookies, setCookie, sql, encrypt, logApi } from '../_lib/core.js';
import { snapToken, snapGet } from '../_lib/snap.js';

const back = (res, q) => { res.statusCode = 302; res.setHeader('Location', `/?${q}#account`); res.end(); };

export default async function handler(req, res) {
  const p = Object.fromEntries(new URL(req.url, 'https://optiroas.com').searchParams);
  const user = await currentUser(req);
  const [state, uid] = String(cookies(req).or_s_state || '').split('.');
  setCookie(res, 'or_s_state', '', 0);
  if (!user) return back(res, 'snap=signin');
  if (p.error) return back(res, 'snap=cancelled');
  if (!p.code || p.state !== state || uid !== user.id) return back(res, 'snap=error&why=state');
  try {
    const tok = await snapToken({ grant_type: 'authorization_code', code: p.code, redirect_uri: process.env.SNAP_REDIRECT_URI });
    if (!tok.refresh_token) throw new Error('Snapchat did not return a refresh token. Please connect again.');
    const access = tok.access_token;
    let me = {};
    try { me = (await snapGet(access, '/me'))[0].me || {}; await logApi(user.id, 'snap:me', true); } catch { await logApi(user.id, 'snap:me', false); }
    const orgs = (await snapGet(access, '/me/organizations', { with_ad_accounts: 'true' })).flatMap(j => j.organizations || []).map(o => o.organization);
    await logApi(user.id, 'snap:organizations', true);
    const accts = [];
    for (const o of orgs) for (const a of (o.ad_accounts || []))
      if (!a.status || a.status === 'ACTIVE') accts.push({ id: a.id, name: a.name, org: o.name, currency: a.currency, tz: a.timezone });
    await sql`insert into snap_connections(user_id,snap_email,snap_name,token_enc) values(${user.id},${me.email || null},${me.display_name || null},${encrypt(tok.refresh_token)})
      on conflict(user_id) do update set snap_email=excluded.snap_email,snap_name=excluded.snap_name,token_enc=excluded.token_enc,updated_at=now()`;
    await sql`delete from snap_ad_accounts where user_id=${user.id}`;
    for (const a of accts)
      await sql`insert into snap_ad_accounts(user_id,account_id,name,org_name,currency,timezone) values(${user.id},${a.id},${a.name || 'Ad account'},${a.org || null},${a.currency || null},${a.tz || null}) on conflict do nothing`;
    return back(res, `snap=connected&n=${accts.length}`);
  } catch (e) {
    console.error('snap callback', e.message, e.code);
    return back(res, 'snap=error&why=' + encodeURIComponent(String(e.message).slice(0, 160)));
  }
}
