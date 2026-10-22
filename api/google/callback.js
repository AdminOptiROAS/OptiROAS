import { currentUser, cookies, setCookie, sql, encrypt, logApi } from '../_lib/core.js';
import { tokenRequest, listAccessible, gaql } from '../_lib/google.js';

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
    const ids = await listAccessible(access); await logApi(user.id, 'google:listAccessibleCustomers', true);
    const accts = new Map();
    for (const id of ids.slice(0, 50)) {
      try {
        const [c] = await gaql(access, id, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer LIMIT 1');
        await logApi(user.id, 'google:customer', true);
        if (!c) continue;
        if (c.customer.manager) {
          const kids = await gaql(access, id, 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.level <= 1 AND customer_client.manager = FALSE', id);
          await logApi(user.id, 'google:customer_client', true);
          for (const k of kids) { const cc = k.customerClient; if (cc.status && cc.status !== 'ENABLED') continue;
            if (!accts.has(String(cc.id))) accts.set(String(cc.id), { id: String(cc.id), name: cc.descriptiveName, currency: cc.currencyCode, tz: cc.timeZone, login: String(id) }); }
        } else accts.set(String(c.customer.id), { id: String(c.customer.id), name: c.customer.descriptiveName, currency: c.customer.currencyCode, tz: c.customer.timeZone, login: null });
      } catch (e) { await logApi(user.id, 'google:customer', false); }
    }
    await sql`insert into google_connections(user_id,google_email,token_enc) values(${user.id},${email},${encrypt(tok.refresh_token)})
      on conflict(user_id) do update set google_email=excluded.google_email,token_enc=excluded.token_enc,updated_at=now()`;
    await sql`delete from google_ad_accounts where user_id=${user.id}`;
    for (const a of accts.values())
      await sql`insert into google_ad_accounts(user_id,customer_id,name,currency,timezone,login_customer_id) values(${user.id},${a.id},${a.name || 'Account ' + a.id},${a.currency || null},${a.tz || null},${a.login})`;
    return back(res, `google=connected&n=${accts.size}`);
  } catch (e) {
    console.error('google callback', e.message, e.code);
    return back(res, 'google=error&why=' + encodeURIComponent(String(e.message).slice(0, 160)));
  }
}
