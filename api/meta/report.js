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
  msg: ['onsite_conversion.messaging_conversation_started_7d']
};
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
  const until = new Date(Date.now() - 864e5), since = new Date(until.getTime() - (days - 1) * 864e5);
  const rows = [], ids = idsParam(q);
  try {
    let page = await graph(`/${account}/insights`, {
      level: 'ad', time_increment: 1, limit: 500,
      time_range: { since: iso(since), until: iso(until) },
      fields: 'date_start,campaign_name,adset_name,ad_name,spend,impressions,reach,inline_link_clicks,actions,action_values,account_currency',
      ...(ids.length ? { filtering: [{ field: 'campaign.id', operator: 'IN', value: ids }] } : {}),
      access_token: token, appsecret_proof: appSecretProof(token)
    }, { userId: user.id });
    for (let i = 0; page && i < 60; i++) {
      rows.push(...(page.data || []));
      const next = page.paging && page.paging.next;
      page = next ? await graph(next, {}, { userId: user.id }) : null;
    }
  } catch (e) {
    const expired = e.meta && (e.meta.code === 190 || e.meta.type === 'OAuthException');
    return json(res, expired ? 409 : 502, { error: expired ? 'Your Meta connection has expired. Reconnect Meta.' : `Meta: ${e.message}` });
  }
  const cur = rows.find(r => r.account_currency)?.account_currency || own[0].currency || 'USD';
  const recs = rows.map(r => ({
    day: r.date_start, camp: r.campaign_name, adset: r.adset_name, ad: r.ad_name,
    spend: +r.spend || 0, impr: +r.impressions || 0, reach: +r.reach || 0, clicks: +r.inline_link_clicks || 0,
    lpv: FIRST(r.actions, K.lpv), atc: FIRST(r.actions, K.atc), ic: FIRST(r.actions, K.ic),
    pur: FIRST(r.actions, K.purchase), val: FIRST(r.action_values, K.purchase),
    lead: FIRST(r.actions, K.lead), msg: FIRST(r.actions, K.msg)
  }));
  const tot = k => recs.reduce((t, r) => t + r[k], 0);
  const mode = tot('pur') > 0 || tot('val') > 0 ? 'purchase' : tot('lead') > 0 ? 'lead' : tot('msg') > 0 ? 'msg' : 'purchase';
  const head = ['Day', 'Campaign name', 'Ad set name', 'Ad name', `Amount spent (${cur})`, 'Impressions', 'Reach', 'Link clicks', 'Landing page views', 'Adds to cart', 'Checkouts initiated']
    .concat(mode === 'purchase' ? ['Purchases', 'Purchases conversion value'] : mode === 'lead' ? ['Leads'] : ['Results', 'Result indicator']);
  const lines = [head.join(',')].concat(recs.map(r => [r.day, r.camp, r.adset, r.ad, r.spend.toFixed(2), r.impr, r.reach, r.clicks, r.lpv, r.atc, r.ic]
    .concat(mode === 'purchase' ? [r.pur, r.val.toFixed(2)] : mode === 'lead' ? [r.lead] : [r.msg, 'actions:onsite_conversion.messaging_conversation_started_7d'])
    .map(csvCell).join(',')));
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Rows', String(recs.length));
  res.setHeader('Content-Disposition', `attachment; filename="meta_${account}_${iso(since)}_${iso(until)}.csv"`);
  res.end(lines.join('\n'));
}
