import { currentUser, sql, json, logApi } from '../_lib/core.js';
import { tokenFor, ttGet } from '../_lib/tiktok.js';

// Returns TikTok ad-level stats by day as a CSV in the layout of a TikTok Ads Manager export,
// so the browser's audit engine reads it unchanged.
const cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
const localDay = (tz, d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(d);
const addDays = (ymd, k) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
const BASE = ['campaign_name', 'adgroup_name', 'ad_name', 'spend', 'impressions', 'clicks', 'conversion'];
const PURCH = ['complete_payment', 'complete_payment_roas', 'value_per_complete_payment'];

async function pull(token, acc, s, e, metrics) {
  const rows = [];
  for (let page = 1; page <= 50; page++) {
    const d = await ttGet(token, '/report/integrated/get/', {
      advertiser_id: acc, report_type: 'BASIC', data_level: 'AUCTION_AD', dimensions: ['ad_id', 'stat_time_day'],
      metrics, start_date: s, end_date: e, page: String(page), page_size: '1000'
    });
    rows.push(...(d.list || []));
    const pi = d.page_info || {};
    if (!pi.total_page || page >= pi.total_page) break;
  }
  return rows;
}

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  const q = new URL(req.url, 'https://optiroas.com').searchParams;
  const acc = String(q.get('account') || '');
  const days = Math.min(90, Math.max(7, parseInt(q.get('days') || '60', 10) || 60));
  const own = await sql`select account_id,name,currency,timezone from tiktok_ad_accounts where user_id=${user.id} and account_id=${acc}`;
  if (!own[0]) return json(res, 404, { error: 'That TikTok ad account isn’t connected to your OptiROAS account.' });
  const tz = own[0].timezone || 'UTC', cur = own[0].currency || 'USD';
  const end = addDays(localDay(tz, new Date()), -1), start = addDays(end, -(days - 1));
  let rows = [], purch = true;
  try {
    const token = await tokenFor(user.id);
    if (!token) return json(res, 409, { error: 'Connect TikTok first.' });
    // Daily reports are requested in windows of up to 30 days.
    for (let s = start; s <= end; s = addDays(s, 30)) {
      const e = addDays(s, 29) < end ? addDays(s, 29) : end;
      try { rows.push(...await pull(token, acc, s, e, purch ? [...BASE, ...PURCH] : BASE)); }
      catch (x) { if (purch && x.code === 40002) { purch = false; rows.push(...await pull(token, acc, s, e, BASE)); } else throw x; }
      await logApi(user.id, 'tiktok:report', true);
    }
  } catch (e) {
    await logApi(user.id, 'tiktok:report', false);
    const expired = e.code === 40105 || e.code === 40104 || e.status === 401;
    return json(res, expired ? 409 : 502, { error: expired ? 'Your TikTok connection has expired. Reconnect TikTok.' : `TikTok: ${e.message}` });
  }
  const out = rows.map(r => { const m = r.metrics || {}, d = r.dimensions || {}, spend = n(m.spend), cp = n(m.complete_payment);
      const value = n(m.complete_payment_roas) > 0 ? n(m.complete_payment_roas) * spend : n(m.value_per_complete_payment) * cp;
      return { day: String(d.stat_time_day || '').slice(0, 10), m, spend, cp, value }; })
    .filter(r => r.spend > 0 || n(r.m.impressions) > 0).sort((a, b) => a.day.localeCompare(b.day));
  const lines = [['By Day', 'Campaign name', 'Ad group name', 'Ad name', 'Currency', 'Cost', 'Impressions', 'Clicks (destination)', 'Complete payment', 'Total complete payment value', 'Conversions'].join(',')]
    .concat(out.map(r => [r.day, r.m.campaign_name, r.m.adgroup_name, r.m.ad_name, cur, r.spend.toFixed(2), Math.round(n(r.m.impressions)), Math.round(n(r.m.clicks)),
      Math.round(r.cp), r.value.toFixed(2), Math.round(n(r.m.conversion))].map(cell).join(',')));
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Rows', String(out.length));
  res.end(lines.join('\n'));
}
