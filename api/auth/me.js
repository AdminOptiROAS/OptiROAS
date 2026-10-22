import { sql, json, currentUser } from '../_lib/core.js';

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 200, { user: null });
  const c = await sql`select meta_name, connected_at from meta_connections where user_id=${user.id}`;
  const accts = c[0] ? await sql`select account_id as id, name, currency, timezone, status from meta_ad_accounts where user_id=${user.id} order by name` : [];
  return json(res, 200, { user, meta: c[0] ? { connected: true, name: c[0].meta_name, since: c[0].connected_at, accounts: accts } : { connected: false } });
}
