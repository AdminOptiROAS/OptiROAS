import { sql, json, currentUser, ensureSchema } from '../_lib/core.js';
import { usageFor, isAdmin } from '../_lib/plan.js';

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
  return json(res, 200, { user: { id: user.id, email: user.email, name: user.name, admin: isAdmin(user) }, usage,
    meta: c[0] ? { connected: true, name: c[0].meta_name, since: c[0].connected_at, accounts: accts } : { connected: false },
    google: g[0] ? { connected: true, email: g[0].google_email, note: g[0].note, since: g[0].connected_at, accounts: gaccts } : { connected: false, available: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) },
    snap: s[0] ? { connected: true, email: s[0].snap_email, name: s[0].snap_name, since: s[0].connected_at, accounts: saccts } : { connected: false, available: !!(process.env.SNAP_CLIENT_ID && process.env.SNAP_CLIENT_SECRET) },
    tiktok: t[0] ? { connected: true, since: t[0].connected_at, accounts: taccts } : { connected: false, available: !!(process.env.TIKTOK_APP_ID && process.env.TIKTOK_APP_SECRET) } });
}
