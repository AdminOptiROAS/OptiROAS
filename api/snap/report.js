import { currentUser, sql, json, decrypt, encrypt, logApi } from '../_lib/core.js';
import { snapToken, snapGet, tzOffset } from '../_lib/snap.js';
import { idsParam } from '../_lib/camps.js';
import { canConnect } from '../_lib/plan.js';

// Returns Snapchat campaign stats by day as a CSV in the layout of a Snapchat Ads Manager export,
// so the browser's audit engine reads it unchanged.
const cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const money = m => ((+m || 0) / 1e6).toFixed(2);
const nice = s => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
const FIELDS = 'impressions,swipes,spend,conversion_purchases,conversion_purchases_value,conversion_sign_ups,conversion_add_cart';
const EXTRA = ',video_views,conversion_page_views,conversion_start_checkout'; // dropped if Snapchat refuses them
// Each campaign is judged on its own objective (Snapchat's objective, or the newer objective type).
const goalOf = c => {
  const o = String(c.objective_v2_properties?.objective_v2_type || c.objective || '').toUpperCase();
  if (/LEAD/.test(o)) return 'sign_up';
  if (/SALES|CONVERSION|CATALOG/.test(o)) return 'purchase';
  if (/TRAFFIC|WEB_VIEW/.test(o)) return 'link_click';
  if (/APP/.test(o)) return 'link_click';
  if (/VIDEO|ENGAGEMENT|REPLAY|STORIES/.test(o)) return 'video_view';
  if (/AWARENESS|REACH/.test(o)) return 'impression';
  return 'purchase';
};

// YYYY-MM-DD of "now" in the account's time zone.
const localDay = (tz, d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(d);
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const bound = (ymd, tz) => `${ymd}T00:00:00.000${tzOffset(tz, new Date(ymd + 'T12:00:00Z'))}`;

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  if (!canConnect(user)) return json(res, 402, { error: 'Connecting ad accounts is part of Starter and Pro. Upgrade to connect.', code: 'upgrade' });
  const q = new URL(req.url, 'https://optiroas.com').searchParams;
  const acc = String(q.get('account') || '');
  const days = Math.min(90, Math.max(7, parseInt(q.get('days') || '60', 10) || 60));
  const own = await sql`select account_id,name,currency,timezone from snap_ad_accounts where user_id=${user.id} and account_id=${acc}`;
  if (!own[0]) return json(res, 404, { error: 'That Snapchat ad account isn’t connected to your OptiROAS account.' });
  const con = await sql`select token_enc from snap_connections where user_id=${user.id}`;
  if (!con[0]) return json(res, 409, { error: 'Connect Snapchat first.' });
  const tz = own[0].timezone || 'UTC', cur = own[0].currency || 'USD';
  const end = localDay(tz, new Date()), start = addDays(end, -days); // full days up to yesterday
  let access, camps = new Map(), series = [], extra = true;
  try {
    const tok = await snapToken({ grant_type: 'refresh_token', refresh_token: decrypt(con[0].token_enc) });
    access = tok.access_token;
    if (tok.refresh_token) await sql`update snap_connections set token_enc=${encrypt(tok.refresh_token)}, updated_at=now() where user_id=${user.id}`;
    for (const j of await snapGet(access, `/adaccounts/${acc}/campaigns`, { limit: '200' }))
      for (const c of (j.campaigns || [])) camps.set(c.campaign.id, c.campaign);
    await logApi(user.id, 'snap:campaigns', true);
    // Day-granularity stats in windows of up to 30 days.
    for (let s = start; s < end; s = addDays(s, 30)) {
      const e = addDays(s, 30) < end ? addDays(s, 30) : end;
      const ask = f => snapGet(access, `/adaccounts/${acc}/stats`, {
        granularity: 'DAY', breakdown: 'campaign', fields: f, start_time: bound(s, tz), end_time: bound(e, tz),
        swipe_up_attribution_window: '28_DAY', view_attribution_window: '1_DAY', omit_empty: 'true'
      });
      let pages;
      try { pages = await ask(extra ? FIELDS + EXTRA : FIELDS); } catch (x) { if (!extra || x.status === 401) throw x; extra = false; pages = await ask(FIELDS); }
      for (const j of pages) for (const t of (j.timeseries_stats || [])) {
        const st = t.timeseries_stat || {};
        const list = (st.breakdown_stats && st.breakdown_stats.campaign) || (st.type === 'CAMPAIGN' ? [st] : []);
        for (const c of list) for (const d of (c.timeseries || [])) series.push({ id: c.id, day: String(d.start_time).slice(0, 10), s: d.stats || {} });
      }
      await logApi(user.id, 'snap:stats', true);
    }
  } catch (e) {
    await logApi(user.id, 'snap:report', false);
    const expired = e.code === 'invalid_grant' || e.status === 401;
    return json(res, expired ? 409 : 502, { error: expired ? 'Your Snapchat connection has expired. Reconnect Snapchat.' : `Snapchat: ${e.message}` });
  }
  const ids = new Set(idsParam(q));
  const rows = series.filter(r => !ids.size || ids.has(r.id)).filter(r => (+r.s.spend || 0) > 0 || (+r.s.impressions || 0) > 0).sort((a, b) => a.day.localeCompare(b.day));
  const RES = { purchase: s => +s.conversion_purchases || 0, sign_up: s => +s.conversion_sign_ups || 0, link_click: s => +s.swipes || 0,
    video_view: s => s.video_views != null ? +s.video_views || 0 : +s.impressions || 0, impression: s => +s.impressions || 0 };
  const lines = [['Date', 'Campaign Name', 'Campaign Status', 'Campaign Objective', 'Daily Budget', 'Currency', 'Paid Impressions', 'Swipe Ups', 'Spend', 'Results', 'Result type', 'Purchases Value', 'Total purchases', 'Total sign ups', 'Adds To Cart', 'Checkouts initiated', 'Landing page views'].join(',')]
    .concat(rows.map(r => { const c = camps.get(r.id) || {}, s = r.s; let g = goalOf(c); if (g === 'video_view' && s.video_views == null) g = 'impression';
      return [r.day, c.name || r.id, nice(c.status), nice(c.objective_v2_properties?.objective_v2_type || c.objective), c.daily_budget_micro ? money(c.daily_budget_micro) : '', cur,
        +s.impressions || 0, +s.swipes || 0, money(s.spend), RES[g](s), 'snap:' + g, g === 'purchase' ? money(s.conversion_purchases_value) : '0.00',
        +s.conversion_purchases || 0, +s.conversion_sign_ups || 0, +s.conversion_add_cart || 0, +s.conversion_start_checkout || 0, +s.conversion_page_views || 0].map(cell).join(','); }));
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Rows', String(rows.length));
  res.end(lines.join('\n'));
}
