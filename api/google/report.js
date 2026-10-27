import { friendly } from '../_lib/errors.js';
import { currentUser, sql, json, decrypt, logApi } from '../_lib/core.js';
import { accessFromRefresh, gaql } from '../_lib/google.js';
import { idsParam } from '../_lib/camps.js';
import { canConnect } from '../_lib/plan.js';

// Returns Google Ads data as CSVs in the same layout as Google Ads UI exports, so the browser's
// audit engine reads them unchanged. type=campaigns (daily campaign report) or type=searchterms.
const cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const iso = d => d.toISOString().slice(0, 10);
const money = m => ((+m || 0) / 1e6).toFixed(2);
// Each campaign is judged on what it is set up to get: the conversion category that brings most of its
// conversions, or, with none yet, its bidding strategy (value bidding = purchases, impression/view bidding = awareness)
// and otherwise the account's main category, so a campaign with no conversions is still judged, not hidden.
const CAT = {
  PURCHASE: 'purchase', STORE_SALE: 'purchase', SUBMIT_LEAD_FORM: 'lead', IMPORTED_LEAD: 'lead', QUALIFIED_LEAD: 'lead', CONVERTED_LEAD: 'lead',
  SIGNUP: 'sign_up', PHONE_CALL_LEAD: 'phone_call', CONTACT: 'contact', BOOK_APPOINTMENT: 'book_appointment', REQUEST_QUOTE: 'lead', GET_DIRECTIONS: 'contact',
  OUTBOUND_CLICK: 'link_click', PAGE_VIEW: 'landing_page_view', DOWNLOAD: 'app_install', ADD_TO_CART: 'add_to_cart', BEGIN_CHECKOUT: 'begin_checkout', SUBSCRIBE_PAID: 'purchase'
};
const SECONDARY = new Set(['add_to_cart', 'begin_checkout', 'landing_page_view', 'link_click']);
const nice = s => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  if (!canConnect(user)) return json(res, 402, { error: 'Connecting ad accounts is part of Starter and Pro. Upgrade to connect.', code: 'upgrade' });
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
  let rows, cats = [];
  try {
    const access = await accessFromRefresh(decrypt(con[0].token_enc));
    rows = type === 'campaigns'
      ? await gaql(access, cid, `SELECT segments.date, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign_budget.amount_micros, customer.currency_code, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.search_budget_lost_impression_share FROM campaign WHERE ${range} AND metrics.impressions > 0`, own[0].login_customer_id)
      : await gaql(access, cid, `SELECT search_term_view.search_term, segments.search_term_match_type, campaign.name, ad_group.name, customer.currency_code, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE ${range} AND metrics.cost_micros > 0`, own[0].login_customer_id);
    if (type === 'campaigns') {
      try {
        cats = await gaql(access, cid, `SELECT segments.date, campaign.name, segments.conversion_action_category, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${range} AND metrics.conversions > 0`, own[0].login_customer_id);
      } catch (e) { cats = []; }
    }
    await logApi(user.id, 'google:' + type, true);
  } catch (e) {
    await logApi(user.id, 'google:' + type, false);
    const expired = e.code === 'invalid_grant';
    return json(res, expired ? 409 : 502, { error: expired ? 'Your Google connection has expired. Reconnect Google Ads.' : friendly('google', e.message).text, code: 'google' });
  }
  const cur = rows[0]?.customer?.currencyCode || own[0].currency || 'USD';
  let lines;
  if (type === 'campaigns') {
    // conversions by day, campaign and category
    const byDay = new Map(), byCamp = new Map(), acct = new Map();
    for (const c of cats) {
      const g = CAT[c.segments?.conversionActionCategory] || 'conversion', v = +c.metrics?.conversions || 0, val = +c.metrics?.conversionsValue || 0, nm = c.campaign?.name;
      const k = c.segments?.date + '\u0001' + nm;
      if (!byDay.has(k)) byDay.set(k, {}); const d = byDay.get(k); d[g] = d[g] || { n: 0, v: 0 }; d[g].n += v; d[g].v += val;
      if (!SECONDARY.has(g)) { if (!byCamp.has(nm)) byCamp.set(nm, {}); const b = byCamp.get(nm); b[g] = (b[g] || 0) + v; acct.set(g, (acct.get(g) || 0) + v); }
    }
    const top = o => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0];
    const main = top(Object.fromEntries(acct)) || 'conversion';
    const goalOf = r => {
      const b = byCamp.get(r.campaign.name); if (b && top(b)) return top(b);
      const bs = String(r.campaign.biddingStrategyType || '');
      if (/TARGET_ROAS|MAXIMIZE_CONVERSION_VALUE/.test(bs)) return 'purchase';
      if (/TARGET_IMPRESSION_SHARE|MANUAL_CPM|TARGET_CPM|MANUAL_CPV|TARGET_CPV/.test(bs)) return 'impression';
      return main;
    };
    const fallback = !cats.length; // category query failed or no conversions at all: keep total conversions as results
    lines = [['Day', 'Campaign status', 'Campaign', 'Budget', 'Currency code', 'Campaign type', 'Bid strategy type', 'Impr.', 'Clicks', 'Cost', 'Results', 'Result type', 'Conv. value', 'All conversions', 'All conv. value', 'Adds to cart', 'Checkouts initiated', 'Search lost IS (budget)'].join(',')]
      .concat(rows.map(r => { const m = r.metrics || {}, lost = m.searchBudgetLostImpressionShare, g = goalOf(r), d = byDay.get(r.segments.date + '\u0001' + r.campaign.name) || {};
        const res = fallback ? (+m.conversions || 0) : g === 'impression' ? (+m.impressions || 0) : (d[g]?.n || 0);
        const val = fallback ? (+m.conversionsValue || 0) : (d.purchase?.v || 0);
        return [r.segments.date, nice(r.campaign.status), r.campaign.name, money(r.campaignBudget?.amountMicros), cur, nice(r.campaign.advertisingChannelType), nice(r.campaign.biddingStrategyType),
          +m.impressions || 0, +m.clicks || 0, money(m.costMicros), res.toFixed(2), fallback ? 'conversions' : 'google:' + g, val.toFixed(2),
          (+m.conversions || 0).toFixed(2), (+m.conversionsValue || 0).toFixed(2), (d.add_to_cart?.n || 0).toFixed(2), (d.begin_checkout?.n || 0).toFixed(2),
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
