import { currentUser, sql, json, body } from '../_lib/core.js';

// Saves the business type (benchmark sub-vertical) on the account, so OptiROAS can build its own
// benchmarks from connected accounts later. Only the category id is stored.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.', code: 'signin' });
  const v = String(body(req).vertical || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || null;
  await sql`update users set vertical=${v} where id=${user.id}`;
  return json(res, 200, { ok: true, vertical: v });
}
