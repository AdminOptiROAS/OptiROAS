import { currentUser, cookies, setCookie, sql, logApi } from '../_lib/core.js';
import { exchangeCode, saveTokens, advertisers } from '../_lib/tiktok.js';

const back = (res, q) => { res.statusCode = 302; res.setHeader('Location', `/?${q}#account`); res.end(); };

export default async function handler(req, res) {
  const p = Object.fromEntries(new URL(req.url, 'https://optiroas.com').searchParams);
  const user = await currentUser(req);
  const [state, uid] = String(cookies(req).or_t_state || '').split('.');
  setCookie(res, 'or_t_state', '', 0);
  if (!user) return back(res, 'tiktok=signin');
  const code = p.auth_code || p.code;
  if (!code) return back(res, 'tiktok=cancelled');
  if (p.state !== state || uid !== user.id) return back(res, 'tiktok=error&why=state');
  try {
    const d = await exchangeCode(code);
    await logApi(user.id, 'tiktok:access_token', true);
    if (!d.access_token) throw new Error('TikTok did not return access. Please connect again.');
    await saveTokens(user.id, d);
    const accts = await advertisers(d.access_token, d.advertiser_ids || []);
    await logApi(user.id, 'tiktok:advertisers', true);
    await sql`delete from tiktok_ad_accounts where user_id=${user.id}`;
    for (const a of accts)
      await sql`insert into tiktok_ad_accounts(user_id,account_id,name,currency,timezone) values(${user.id},${a.id},${a.name},${a.currency},${a.tz}) on conflict do nothing`;
    return back(res, `tiktok=connected&n=${accts.length}`);
  } catch (e) {
    await logApi(user.id, 'tiktok:callback', false);
    console.error('tiktok callback', e.message, e.code);
    return back(res, 'tiktok=error&why=' + encodeURIComponent(String(e.message).slice(0, 160)));
  }
}
