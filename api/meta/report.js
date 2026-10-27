import { friendly } from '../_lib/errors.js';
import { currentUser, sql, json, metaToken, graph, appSecretProof } from '../_lib/core.js';
import { idsParam } from '../_lib/camps.js';
import { canConnect } from '../_lib/plan.js';

// Pulls daily ad-level insights for one connected ad account and returns them as a CSV in the
// same layout as a Meta Ads Manager export, so the browser's audit engine reads it unchanged.
const FIRST = (list, keys) => { for (const k of keys) { const a = (list || []).find(x => x.action_type === k); if (a) return +a.value || 0; } return 0; };
const K = {
  purchase: ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase'],
  lpv: ['omni_landing_page_view', 'landing_page_view'],
  atc: ['omni_add_to_cart', 'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart'],
  ic: ['omni_initiated_checkout', 'initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout'],
  lead: ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'],
  msg: ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection'],
  v3: ['video_view'], eng: ['post_engagement'], link: ['link_click']
};
// What each row is optimised for, from Meta's optimisation goal, then the campaign objective.
// Indicator strings follow Meta's own "Result indicator" so the audit engine reads them unchanged.
const IND = { purchase: 'actions:offsite_conversion.fb_pixel_purchase', lead: 'actions:lead', msg: 'actions:onsite_conversion.messaging_conversation_started_7d',
  click: 'actions:link_click', lpv: 'actions:landing_page_view', video: 'actions:video_view', eng: 'actions:post_engagement', reach: 'reach' };
function goalOf(r) {
  const g = String(r.optimization_goal || '').toUpperCase(), o = String(r.objective || '').toUpperCase();
  if (g === 'CONVERSATIONS') return 'msg';
  if (g === 'LEAD_GENERATION' || g === 'QUALITY_LEAD' || g === 'QUALITY_CALL') return 'lead';
  if (g === 'VALUE' || (g === 'OFFSITE_CONVERSIONS' && /SALES|CONVERSIONS|CATALOG/.test(o))) return 'purchase';
  if (g === 'OFFSITE_CONVERSIONS' && /LEAD/.test(o)) return 'lead';
  if (g === 'LANDING_PAGE_VIEWS') return 'lpv';
  if (g === 'LINK_CLICKS') return 'click';
  if (/THRUPLAY|VIDEO_VIEWS/.test(g)) return 'video';
  if (/POST_ENGAGEMENT|PAGE_LIKES|EVENT_RESPONSES/.test(g)) return 'eng';
  if (/REACH|IMPRESSIONS|AD_RECALL/.test(g)) return 'reach';
  if (/SALES|CONVERSIONS|CATALOG/.test(o)) return 'purchase';
  if (/LEAD/.test(o)) return 'lead';
  if (/MESSAGES/.test(o)) return 'msg';
  if (/TRAFFIC|LINK_CLICKS/.test(o)) return 'click';
  if (/AWARENESS|REACH/.test(o)) return 'reach';
  if (/ENGAGEMENT/.test(o)) return 'eng';
  return null;
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const iso = d => d.toISOString().slice(0, 10);


export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  if (!canConnect(user)) return json(res, 402, { error: 'Connecting ad accounts is part of Starter and Pro. Upgrade to connect.', code: 'upgrade' });
  const q = new URL(req.url, 'https://optiroas.com').searchParams;
  const account = String(q.get('account') || '');
  const days = Math.min(90, Math.max(7, parseInt(q.get('days') || '60', 10) || 60));
  const own = await sql`select account_id,name,currency from meta_ad_accounts where user_id=${user.id} and account_id=${account}`;
  if (!own[0]) return json(res, 404, { error: 'That ad account isn’t connected to your OptiROAS account.' });
  const token = await metaToken(user.id);
  if (!token) return json(res, 409, { error: 'Connect Meta first.' });
  // today=1 includes today so far (for the live view); if Meta refuses today's date for this account's time zone, fall back to yesterday
  const wantToday = q.get('today') === '1';
  let until = new Date(Date.now() - (wantToday ? 0 : 864e5)), since = new Date(until.getTime() - (days - 1) * 864e5);
  const ids = idsParam(q);
  let rows = [];
  const pull = async () => {
    rows = [];
    let page = await graph(`/${account}/insights`, {
      level: 'ad', time_increment: 1, limit: 500,
      time_range: { since: iso(since), until: iso(until) },
      fields: 'date_start,campaign_name,adset_name,ad_name,objective,optimization_goal,spend,impressions,reach,inline_link_clicks,actions,action_values,account_currency',
      ...(ids.length ? { filtering: [{ field: 'campaign.id', operator: 'IN', value: ids }] } : {}),
      access_token: token, appsecret_proof: appSecretProof(token)
    }, { userId: user.id });
    for (let i = 0; page && i < 60; i++) {
      rows.push(...(page.data || []));
      const next = page.paging && page.paging.next;
      page = next ? await graph(next, {}, { userId: user.id }) : null;
    }
  };
  let todayIn = wantToday;
  try {
    try { await pull(); }
    catch (e) {
      const expired = e.meta && (e.meta.code === 190 || e.meta.type === 'OAuthException');
      if (!wantToday || expired) throw e;
      until = new Date(Date.now() - 864e5); since = new Date(until.getTime() - (days - 1) * 864e5); todayIn = false;
      await pull();
    }
  } catch (e) {
    const expired = e.meta && (e.meta.code === 190 || e.meta.type === 'OAuthException');
    return json(res, expired ? 409 : 502, { error: expired ? 'Your Meta connection has expired. Reconnect Meta.' : friendly('meta', (e.meta&&e.meta.code)+' '+e.message).text });
  }
  const cur = rows.find(r => r.account_currency)?.account_currency || own[0].currency || 'USD';
  const recs = rows.map(r => ({
    day: r.date_start, camp: r.campaign_name, adset: r.adset_name, ad: r.ad_name, objective: r.objective || '', goalRaw: r.optimization_goal || '',
    spend: +r.spend || 0, impr: +r.impressions || 0, reach: +r.reach || 0, clicks: +r.inline_link_clicks || 0,
    lpv: FIRST(r.actions, K.lpv), atc: FIRST(r.actions, K.atc), ic: FIRST(r.actions, K.ic),
    pur: FIRST(r.actions, K.purchase), val: FIRST(r.action_values, K.purchase),
    lead: FIRST(r.actions, K.lead), msg: FIRST(r.actions, K.msg), v3: FIRST(r.actions, K.v3), eng: FIRST(r.actions, K.eng), goal: goalOf(r)
  }));
  // rows Meta didn't tag with a goal: take the result type that has any value
  recs.forEach(r => { if (!r.goal) r.goal = r.pur || r.val ? 'purchase' : r.msg ? 'msg' : r.lead ? 'lead' : 'click'; });
  // Meta sometimes omits the optimisation goal; an engagement-objective campaign that starts conversations is a messaging campaign
  { const byCamp = new Map(); recs.forEach(r => { const c = byCamp.get(r.camp) || { msg: 0, lead: 0, pur: 0 }; c.msg += r.msg; c.lead += r.lead; c.pur += r.pur; byCamp.set(r.camp, c); });
    recs.forEach(r => { if (r.goalRaw) return; const c = byCamp.get(r.camp); if (r.goal === 'eng' || r.goal === 'click' || r.goal === 'reach') r.goal = c.msg > 0 ? 'msg' : c.lead > 0 ? 'lead' : c.pur > 0 ? 'purchase' : r.goal; }); }
  const RES = { purchase: r => r.pur, lead: r => r.lead, msg: r => r.msg, click: r => r.clicks, lpv: r => r.lpv, video: r => r.v3, eng: r => r.eng, reach: r => r.reach };
  const head = ['Day', 'Campaign name', 'Ad set name', 'Ad name', 'Campaign objective', 'Optimisation goal', `Amount spent (${cur})`, 'Impressions', 'Reach', 'Link clicks', 'Landing page views', 'Adds to cart', 'Checkouts initiated',
    'Results', 'Result indicator', 'Purchases conversion value', 'Total purchases', 'Total leads', 'Conversations started', '3-second video plays', 'Post engagements'];
  const lines = [head.join(',')].concat(recs.map(r => [r.day, r.camp, r.adset, r.ad, r.objective, r.goalRaw, r.spend.toFixed(2), r.impr, r.reach, r.clicks, r.lpv, r.atc, r.ic,
    RES[r.goal](r), IND[r.goal], r.goal === 'purchase' ? r.val.toFixed(2) : '0', r.pur, r.lead, r.msg, r.v3, r.eng].map(csvCell).join(',')));
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Rows', String(recs.length));
  res.setHeader('X-Until', iso(until));
  res.setHeader('X-Today', todayIn ? '1' : '0');
  res.setHeader('Content-Disposition', `attachment; filename="meta_${account}_${iso(since)}_${iso(until)}.csv"`);
  res.end(lines.join('\n'));
}
