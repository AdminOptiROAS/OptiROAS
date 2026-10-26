import { currentUser, sql, json } from '../_lib/core.js';
import { isAdmin } from '../_lib/plan.js';

// Admin only: the last 100 Meta Graph calls with their error messages, to fix failures before Meta's access review.
export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user || !isAdmin(user)) return json(res, 403, { error: 'Admins only.' });
  const rows = await sql`select at, ok, regexp_replace(endpoint,'act_[0-9]+','act_*','g') as endpoint, err from api_log
    where endpoint like '/v%' order by at desc limit 100`;
  return json(res, 200, { rows });
}
