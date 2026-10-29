import { friendly } from '../_lib/errors.js';
import { currentUser, sql, json, decrypt, logApi } from '../_lib/core.js';
import { accessFromRefresh, gaql } from '../_lib/google.js';
import { STATUS, range, daysParam } from '../_lib/camps.js';
import { canConnect } from '../_lib/plan.js';

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  if (!canConnect(user)) return json(res, 402, { error: 'Connecting ad accounts is part of Starter and Pro. Upgrade to connect.', code: 'upgrade' });
  const q = new URL(req.url, 'https://optiroas.com').searchParams;
  const cid = String(q.get('account') || '').replace(/-/g, ''), days = daysParam(q), r = range(days);
  const own = await sql`select customer_id,currency,login_customer_id from google_ad_accounts where user_id=${user.id} and customer_id=${cid}`;
  if (!own[0]) return json(res, 404, { error: 'That Google Ads account isn’t connected to your OptiROAS account.' });
  const con = await sql`select token_enc from google_connections where user_id=${user.id}`;
  if (!con[0]) return json(res, 409, { error: 'Connect Google Ads first.' });
  try {
    const access = await accessFromRefresh(decrypt(con[0].token_enc)), login = own[0].login_customer_id;
    const list = await gaql(access, cid, "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.status != 'REMOVED'", login);
    const st = await gaql(access, cid, `SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.impressions FROM campaign WHERE segments.date BETWEEN '${r.since}' AND '${r.until}' AND metrics.impressions > 0`, login);
    await logApi(user.id, 'google:campaigns', true);
    const m = new Map();
    for (const x of list) m.set(String(x.campaign.id), { id: String(x.campaign.id), name: x.campaign.name, status: STATUS(x.campaign.status), objective: x.campaign.advertisingChannelType || null, spend: 0, impr: 0 });
    for (const x of st) { const id = String(x.campaign.id), c = m.get(id) || { id, name: x.campaign.name, status: STATUS(x.campaign.status), spend: 0, impr: 0 };
      c.spend += (+x.metrics.costMicros || 0) / 1e6; c.impr += +x.metrics.impressions || 0; m.set(id, c); }
    return json(res, 200, { currency: own[0].currency, since: r.since, until: r.until, campaigns: [...m.values()] });
  } catch (e) {
    await logApi(user.id, 'google:campaigns', false, String((e && (e.code || '')) + ' ' + (e && e.message || '')).slice(0, 280));
    const expired = e.code === 'invalid_grant';
    return json(res, expired ? 409 : 502, { error: expired ? 'Your Google connection has expired. Reconnect Google Ads.' : friendly('google', e.message).text, code: 'google' });
  }
}
