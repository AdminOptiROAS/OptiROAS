import { friendly } from '../_lib/errors.js';
import { currentUser, sql, json, metaToken, graph, appSecretProof } from '../_lib/core.js';
import { STATUS, range, daysParam } from '../_lib/camps.js';
import { canConnect } from '../_lib/plan.js';

// Lists an ad account's campaigns with status and results for the chosen period, for the campaign picker.
export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  if (!canConnect(user)) return json(res, 402, { error: 'Connecting ad accounts is part of Starter and Pro. Upgrade to connect.', code: 'upgrade' });
  const q = new URL(req.url, 'https://optiroas.com').searchParams;
  const account = String(q.get('account') || ''), days = daysParam(q), r = range(days);
  const own = await sql`select account_id,currency from meta_ad_accounts where user_id=${user.id} and account_id=${account}`;
  if (!own[0]) return json(res, 404, { error: 'That ad account isn’t connected to your OptiROAS account.' });
  const token = await metaToken(user.id);
  if (!token) return json(res, 409, { error: 'Connect Meta first.' });
  const auth = { access_token: token, appsecret_proof: appSecretProof(token) };
  try {
    const list = [], stats = {};
    let page = await graph(`/${account}/campaigns`, { fields: 'id,name,effective_status,objective,daily_budget,lifetime_budget,stop_time', limit: 500, ...auth }, { userId: user.id });
    for (let i = 0; page && i < 10; i++) { list.push(...(page.data || [])); page = page.paging && page.paging.next ? await graph(page.paging.next, {}, { userId: user.id }) : null; }
    page = await graph(`/${account}/insights`, { level: 'campaign', fields: 'campaign_id,campaign_name,spend,impressions', time_range: r, limit: 500, ...auth }, { userId: user.id });
    for (let i = 0; page && i < 10; i++) { for (const x of (page.data || [])) stats[x.campaign_id] = x; page = page.paging && page.paging.next ? await graph(page.paging.next, {}, { userId: user.id }) : null; }
    const seen = new Set(list.map(c => c.id));
    for (const id of Object.keys(stats)) if (!seen.has(id)) list.push({ id, name: stats[id].campaign_name, effective_status: 'ARCHIVED' });
    const campaigns = list.map(c => ({ id: c.id, name: c.name, status: STATUS(c.effective_status), objective: c.objective || null,
      spend: +(stats[c.id]?.spend || 0), impr: +(stats[c.id]?.impressions || 0) }));
    return json(res, 200, { currency: own[0].currency, since: r.since, until: r.until, campaigns });
  } catch (e) {
    const expired = e.meta && (e.meta.code === 190 || e.meta.type === 'OAuthException');
    return json(res, expired ? 409 : 502, { error: expired ? 'Your Meta connection has expired. Reconnect Meta.' : friendly('meta', (e.meta&&e.meta.code)+' '+e.message).text });
  }
}
