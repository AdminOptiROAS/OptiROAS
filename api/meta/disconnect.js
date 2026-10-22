import { currentUser, sql, json, metaToken, graph, appSecretProof } from '../_lib/core.js';

// Removes the stored Meta token and ad accounts. Tries to revoke the permission on Meta's side too.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  try { const t = await metaToken(user.id); if (t) await graph('/me/permissions', { access_token: t, appsecret_proof: appSecretProof(t) }, { userId: user.id, method: 'DELETE' }); } catch {}
  await sql`delete from meta_ad_accounts where user_id=${user.id}`;
  await sql`delete from meta_connections where user_id=${user.id}`;
  return json(res, 200, { ok: true });
}
