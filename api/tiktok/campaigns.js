import { currentUser, sql, json, logApi } from '../_lib/core.js';
import { tokenFor, ttGet } from '../_lib/tiktok.js';
import { STATUS, daysParam } from '../_lib/camps.js';

const localDay = (tz, d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(d);
const addDays = (ymd, k) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  const q = new URL(req.url, 'https://optiroas.com').searchParams;
  const acc = String(q.get('account') || ''), days = daysParam(q);
  const own = await sql`select account_id,currency,timezone from tiktok_ad_accounts where user_id=${user.id} and account_id=${acc}`;
  if (!own[0]) return json(res, 404, { error: 'That TikTok ad account isn’t connected to your OptiROAS account.' });
  const tz = own[0].timezone || 'UTC', end = addDays(localDay(tz, new Date()), -1), start = addDays(end, -(days - 1));
  try {
    const token = await tokenFor(user.id);
    if (!token) return json(res, 409, { error: 'Connect TikTok first.' });
    const m = new Map();
    for (let page = 1; page <= 10; page++) {
      const d = await ttGet(token, '/campaign/get/', { advertiser_id: acc, page: String(page), page_size: '1000', fields: ['campaign_id', 'campaign_name', 'operation_status', 'objective_type'] });
      for (const c of (d.list || [])) m.set(String(c.campaign_id), { id: String(c.campaign_id), name: c.campaign_name, status: STATUS(c.operation_status), objective: c.objective_type || null, spend: 0, impr: 0 });
      if (!d.page_info || page >= (d.page_info.total_page || 1)) break;
    }
    for (let s = start; s <= end; s = addDays(s, 30)) {
      const e = addDays(s, 29) < end ? addDays(s, 29) : end;
      const d = await ttGet(token, '/report/integrated/get/', { advertiser_id: acc, report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN', dimensions: ['campaign_id'], metrics: ['spend', 'impressions'], start_date: s, end_date: e, page_size: '1000' });
      for (const r of (d.list || [])) { const id = String(r.dimensions.campaign_id), x = m.get(id); if (x) { x.spend += +r.metrics.spend || 0; x.impr += +r.metrics.impressions || 0; } }
    }
    await logApi(user.id, 'tiktok:campaigns', true);
    return json(res, 200, { currency: own[0].currency, since: start, until: end, campaigns: [...m.values()] });
  } catch (e) {
    await logApi(user.id, 'tiktok:campaigns', false);
    return json(res, 502, { error: `TikTok: ${e.message}` });
  }
}
