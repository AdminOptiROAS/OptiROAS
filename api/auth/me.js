import { sql, json, currentUser, ensureSchema } from '../_lib/core.js';

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 200, { user: null });
  const c = await sql`select meta_name, connected_at from meta_connections where user_id=${user.id}`;
  const accts = c[0] ? await sql`select account_id as id, name, currency, timezone, status from meta_ad_accounts where user_id=${user.id} order by name` : [];
  const g = await sql`select google_email, connected_at from google_connections where user_id=${user.id}`;
  const gaccts = g[0] ? await sql`select customer_id as id, name, currency, timezone from google_ad_accounts where user_id=${user.id} order by name` : [];
  return json(res, 200, { user,
    meta: c[0] ? { connected: true, name: c[0].meta_name, since: c[0].connected_at, accounts: accts } : { connected: false },
    google: g[0] ? { connected: true, email: g[0].google_email, since: g[0].connected_at, accounts: gaccts } : { connected: false, available: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) } });
}
