import { currentUser, sql, json, decrypt, logApi } from '../_lib/core.js';
import { accessFromRefresh, gaql } from '../_lib/google.js';
import { idsParam } from '../_lib/camps.js';

// Returns Google Ads data as CSVs in the same layout as Google Ads UI exports, so the browser's
// audit engine reads them unchanged. type=campaigns (daily campaign report) or type=searchterms.
const cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const iso = d => d.toISOString().slice(0, 10);
const money = m => ((+m || 0) / 1e6).toFixed(2);
const nice = s => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  const q = new URL(req.url, 'https://optiroas.com').searchParams;
  const cid = String(q.get('account') || '').replace(/-/g, ''), type = q.get('type') === 'searchterms' ? 'searchterms' : 'campaigns';
  const days = Math.min(90, Math.max(7, parseInt(q.get('days') || '60', 10) || 60));
  const own = await sql`select customer_id,name,currency,login_customer_id from google_ad_accounts where user_id=${user.id} and customer_id=${cid}`;
  if (!own[0]) return json(res, 404, { error: 'That Google Ads account isn’t connected to your OptiROAS account.' });
  const con = await sql`select token_enc from google_connections where user_id=${user.id}`;
  if (!con[0]) return json(res, 409, { error: 'Connect Google Ads first.' });
  const until = new Date(Date.now() - 864e5), since = new Date(until.getTime() - (days - 1) * 864e5);
  const ids = idsParam(q).filter(x => /^\d+$/.test(x));
  const range = `segments.date BETWEEN '${iso(since)}' AND '${iso(until)}'` + (ids.length ? ` AND campaign.id IN (${ids.join(',')})` : '');
  let rows;
  try {
    const access = await accessFromRefresh(decrypt(con[0].token_enc));
    rows = type === 'campaigns'
      ? await gaql(access, cid, `SELECT segments.date, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, customer.currency_code, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.search_budget_lost_impression_share FROM campaign WHERE ${range} AND metrics.impressions > 0`, own[0].login_customer_id)
      : await gaql(access, cid, `SELECT search_term_view.search_term, segments.search_term_match_type, campaign.name, ad_group.name, customer.currency_code, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE ${range} AND metrics.cost_micros > 0`, own[0].login_customer_id);
    await logApi(user.id, 'google:' + type, true);
  } catch (e) {
    await logApi(user.id, 'google:' + type, false);
    const expired = e.code === 'invalid_grant';
    return json(res, expired ? 409 : 502, { error: expired ? 'Your Google connection has expired. Reconnect Google Ads.' : `Google Ads: ${e.message}` });
  }
  const cur = rows[0]?.customer?.currencyCode || own[0].currency || 'USD';
  let lines;
  if (type === 'campaigns') {
    lines = [['Day', 'Campaign status', 'Campaign', 'Budget', 'Currency code', 'Campaign type', 'Impr.', 'Clicks', 'Cost', 'Conversions', 'Conv. value', 'Search lost IS (budget)'].join(',')]
      .concat(rows.map(r => { const m = r.metrics || {}, lost = m.searchBudgetLostImpressionShare;
        return [r.segments.date, nice(r.campaign.status), r.campaign.name, money(r.campaignBudget?.amountMicros), cur, nice(r.campaign.advertisingChannelType),
          +m.impressions || 0, +m.clicks || 0, money(m.costMicros), (+m.conversions || 0).toFixed(2), (+m.conversionsValue || 0).toFixed(2),
          lost == null ? '' : (lost * 100).toFixed(2) + '%'].map(cell).join(','); }));
  } else {
    lines = [['Search term', 'Match type', 'Campaign', 'Ad group', 'Currency code', 'Cost', 'Impr.', 'Clicks', 'Conversions', 'Conv. value'].join(',')]
      .concat(rows.map(r => { const m = r.metrics || {};
        return [r.searchTermView.searchTerm, nice(r.segments.searchTermMatchType), r.campaign.name, r.adGroup.name, cur, money(m.costMicros),
          +m.impressions || 0, +m.clicks || 0, (+m.conversions || 0).toFixed(2), (+m.conversionsValue || 0).toFixed(2)].map(cell).join(','); }));
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Rows', String(rows.length));
  res.end(lines.join('\n'));
}
