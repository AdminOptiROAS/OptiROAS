import { ensureSchema, sql, json } from './_lib/core.js';

// Reports whether the server, database and required settings are in place (no secrets returned).
export default async function handler(req, res) {
  const need = ['DATABASE_URL', 'ENCRYPTION_KEY', 'META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID', 'META_REDIRECT_URI'];
  const missing = need.filter(k => !process.env[k]);
  let db = 'ok', users = null, calls = null;
  try {
    await ensureSchema();
    users = (await sql`select count(*)::int as n from users`)[0].n;
    calls = (await sql`select count(*) filter (where ok)::int as ok, count(*)::int as total from api_log where at > now() - interval '15 days'`)[0];
  } catch (e) { db = 'error: ' + String(e.message).slice(0, 120); }
  return json(res, missing.length || db !== 'ok' ? 500 : 200, { ok: !missing.length && db === 'ok', missing, db, users, metaCallsLast15Days: calls, graph: process.env.META_GRAPH_VERSION || null });
}
