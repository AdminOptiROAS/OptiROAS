import { friendly } from '../_lib/errors.js';
import { currentUser, sql, json, decrypt, encrypt, logApi } from '../_lib/core.js';
import { snapToken, snapGet, tzOffset } from '../_lib/snap.js';
import { STATUS, daysParam } from '../_lib/camps.js';
import { canConnect } from '../_lib/plan.js';

const localDay = (tz, d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(d);
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const bound = (ymd, tz) => `${ymd}T00:00:00.000${tzOffset(tz, new Date(ymd + 'T12:00:00Z'))}`;

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  if (!canConnect(user)) return json(res, 402, { error: 'Connecting ad accounts is part of Starter and Pro. Upgrade to connect.', code: 'upgrade' });
  const q = new URL(req.url, 'https://optiroas.com').searchParams;
  const acc = String(q.get('account') || ''), days = daysParam(q);
  const own = await sql`select account_id,currency,timezone from snap_ad_accounts where user_id=${user.id} and account_id=${acc}`;
  if (!own[0]) return json(res, 404, { error: 'That Snapchat ad account isn’t connected to your OptiROAS account.' });
  const con = await sql`select token_enc from snap_connections where user_id=${user.id}`;
  if (!con[0]) return json(res, 409, { error: 'Connect Snapchat first.' });
  const tz = own[0].timezone || 'UTC', end = localDay(tz, new Date()), start = addDays(end, -days);
  try {
    const tok = await snapToken({ grant_type: 'refresh_token', refresh_token: decrypt(con[0].token_enc) });
    if (tok.refresh_token) await sql`update snap_connections set token_enc=${encrypt(tok.refresh_token)}, updated_at=now() where user_id=${user.id}`;
    const m = new Map();
    for (const j of await snapGet(tok.access_token, `/adaccounts/${acc}/campaigns`, { limit: '200' }))
      for (const c of (j.campaigns || [])) { const x = c.campaign;
        m.set(x.id, { id: x.id, name: x.name, status: x.end_time && new Date(x.end_time) < new Date() ? 'other' : STATUS(x.status), objective: x.objective || null, spend: 0, impr: 0 }); }
    for (let s = start; s < end; s = addDays(s, 30)) {
      const e = addDays(s, 30) < end ? addDays(s, 30) : end;
      for (const j of await snapGet(tok.access_token, `/adaccounts/${acc}/stats`, { granularity: 'TOTAL', breakdown: 'campaign', fields: 'impressions,spend', start_time: bound(s, tz), end_time: bound(e, tz) }))
        for (const t of (j.total_stats || [])) for (const c of ((t.total_stat && t.total_stat.breakdown_stats && t.total_stat.breakdown_stats.campaign) || [])) {
          const x = m.get(c.id); if (x) { x.spend += (+c.stats.spend || 0) / 1e6; x.impr += +c.stats.impressions || 0; } }
    }
    await logApi(user.id, 'snap:campaigns', true);
    return json(res, 200, { currency: own[0].currency, since: start, until: addDays(end, -1), campaigns: [...m.values()] });
  } catch (e) {
    await logApi(user.id, 'snap:campaigns', false);
    const expired = e.code === 'invalid_grant' || e.status === 401;
    return json(res, expired ? 409 : 502, { error: expired ? 'Your Snapchat connection has expired. Reconnect Snapchat.' : friendly('snap', (e.status||'')+' '+e.message).text });
  }
}
