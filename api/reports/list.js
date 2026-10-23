import { currentUser, sql, json } from '../_lib/core.js';

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  const r = await sql`select id,label,period,currency,score,created_at,followup_at,followup_sent_at,
      jsonb_array_length(data->'findings') as total,
      (select count(*) from jsonb_array_elements(data->'findings') e where (e->>'done')::boolean) as done
    from saved_reports where user_id=${user.id} order by created_at desc limit 100`;
  return json(res, 200, { reports: r.map(x => ({ ...x, total: +x.total, done: +x.done })) });
}
