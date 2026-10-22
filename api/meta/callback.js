import { currentUser, cookies, setCookie, sql, encrypt, graph, appSecretProof } from '../_lib/core.js';

const back = (res, q) => { res.statusCode = 302; res.setHeader('Location', `/?${q}#audit`); res.end(); };

// Facebook sends the user back here with ?code=…&state=…
export default async function handler(req, res) {
  const url = new URL(req.url, 'https://optiroas.com');
  const p = Object.fromEntries(url.searchParams);
  const user = await currentUser(req);
  const [state, uid] = String(cookies(req).or_meta_state || '').split('.');
  setCookie(res, 'or_meta_state', '', 0);
  if (!user) return back(res, 'meta=signin');
  if (p.error) return back(res, 'meta=cancelled');
  if (!p.code || !p.state || p.state !== state || uid !== user.id) return back(res, 'meta=error&why=state');
  try {
    const tok = await graph('/oauth/access_token', {
      client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET,
      redirect_uri: process.env.META_REDIRECT_URI, code: p.code
    }, { userId: user.id });
    const token = tok.access_token;
    if (!token) throw new Error('No access token returned');
    const proof = appSecretProof(token);
    const me = await graph('/me', { fields: 'id,name,client_business_id', access_token: token, appsecret_proof: proof }, { userId: user.id }).catch(() => ({}));
    const fields = 'account_id,name,currency,timezone_name,account_status';
    let accts = [];
    const pull = async path => { try { const r = await graph(path, { fields, limit: 200, access_token: token, appsecret_proof: proof }, { userId: user.id }); return r.data || []; } catch { return []; } };
    accts = await pull('/me/adaccounts');
    if (!accts.length && me.client_business_id) accts = [...await pull(`/${me.client_business_id}/owned_ad_accounts`), ...await pull(`/${me.client_business_id}/client_ad_accounts`)];
    await sql`insert into meta_connections(user_id,meta_id,meta_name,client_business_id,token_enc)
      values(${user.id},${me.id || null},${me.name || null},${me.client_business_id || null},${encrypt(token)})
      on conflict(user_id) do update set meta_id=excluded.meta_id,meta_name=excluded.meta_name,
      client_business_id=excluded.client_business_id,token_enc=excluded.token_enc,updated_at=now()`;
    await sql`delete from meta_ad_accounts where user_id=${user.id}`;
    const seen = new Set();
    for (const a of accts) {
      const id = 'act_' + String(a.account_id || a.id).replace(/^act_/, '');
      if (seen.has(id)) continue; seen.add(id);
      await sql`insert into meta_ad_accounts(user_id,account_id,name,currency,timezone,status)
        values(${user.id},${id},${a.name || id},${a.currency || null},${a.timezone_name || null},${a.account_status ?? null})`;
    }
    return back(res, `meta=connected&n=${seen.size}`);
  } catch (e) {
    console.error('meta callback', e.message, e.meta);
    return back(res, 'meta=error&why=' + encodeURIComponent(String(e.message).slice(0, 140)));
  }
}
