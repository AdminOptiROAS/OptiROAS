import { sql, json, currentUser, ensureSchema } from '../_lib/core.js';
import { usageFor, isAdmin } from '../_lib/plan.js';
import { friendly } from '../_lib/errors.js';

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 200, { user: null });
  const c = await sql`select meta_name, connected_at from meta_connections where user_id=${user.id}`;
  const accts = c[0] ? await sql`select account_id as id, name, currency, timezone, status from meta_ad_accounts where user_id=${user.id} order by name` : [];
  const g = await sql`select google_email, connected_at, note from google_connections where user_id=${user.id}`;
  const gaccts = g[0] ? await sql`select customer_id as id, name, currency, timezone from google_ad_accounts where user_id=${user.id} order by name` : [];
  const s = await sql`select snap_email, snap_name, connected_at from snap_connections where user_id=${user.id}`;
  const saccts = s[0] ? await sql`select account_id as id, name, org_name as org, currency, timezone from snap_ad_accounts where user_id=${user.id} order by name` : [];
  const t = await sql`select connected_at from tiktok_connections where user_id=${user.id}`;
  const taccts = t[0] ? await sql`select account_id as id, name, currency, timezone from tiktok_ad_accounts where user_id=${user.id} order by name` : [];
  const usage = await usageFor(user);
  // connection health: last successful pull and the latest problem per platform (from the API call log)
  const H = {};
  try {
    const rows = await sql`select k, max(at) filter (where ok) as last_ok, max(at) filter (where not ok) as last_err,
        (array_agg(err order by at desc) filter (where not ok))[1] as err
      from (select case when endpoint like '/v%' then 'meta' when endpoint like 'google:%' then 'google' when endpoint like 'snap:%' then 'snap' when endpoint like 'tiktok:%' then 'tiktok' else 'other' end as k, ok, at, err
            from api_log where user_id=${user.id} and at > now() - interval '90 days') x group by k`;
    for (const r of rows) { const bad = r.last_err && (!r.last_ok || new Date(r.last_err) > new Date(r.last_ok)); H[r.k] = { lastOk: r.last_ok, lastErr: bad ? r.last_err : null, problem: bad ? friendly(r.k, r.err || '') : null }; }
  } catch (e) { }
  const hp = (k, o) => Object.assign(o, H[k] ? { health: H[k] } : {});
  return json(res, 200, { user: { id: user.id, email: user.email, name: user.name, admin: isAdmin(user), vertical: user.vertical || null }, usage,
    meta: hp('meta', c[0] ? { connected: true, name: c[0].meta_name, since: c[0].connected_at, accounts: accts } : { connected: false }),
    google: hp('google', g[0] ? { connected: true, email: g[0].google_email, note: g[0].note, since: g[0].connected_at, accounts: gaccts } : { connected: false, available: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) }),
    snap: hp('snap', s[0] ? { connected: true, email: s[0].snap_email, name: s[0].snap_name, since: s[0].connected_at, accounts: saccts } : { connected: false, available: !!(process.env.SNAP_CLIENT_ID && process.env.SNAP_CLIENT_SECRET) }),
    tiktok: hp('tiktok', t[0] ? { connected: true, since: t[0].connected_at, accounts: taccts } : { connected: false, available: !!(process.env.TIKTOK_APP_ID && process.env.TIKTOK_APP_SECRET) }) });
}
