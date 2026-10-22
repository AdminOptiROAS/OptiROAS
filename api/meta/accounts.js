import { currentUser, sql, json } from '../_lib/core.js';

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  const accts = await sql`select account_id as id,name,currency,timezone,status from meta_ad_accounts where user_id=${user.id} order by name`;
  return json(res, 200, { accounts: accts });
}
