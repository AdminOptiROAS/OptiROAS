import { ensureSchema, sql, json } from './_lib/core.js';

// Reports whether the server, database and required settings are in place (no secrets returned).
export default async function handler(req, res) {
  const need = ['DATABASE_URL', 'ENCRYPTION_KEY', 'META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID', 'META_REDIRECT_URI'];
  const missing = need.filter(k => !process.env[k]);
  let db = 'ok', users = null, calls = null;
  try {
    await ensureSchema();
    users = (await sql`select count(*)::int as n from users`)[0].n;
    // Meta Graph calls only (paths start with the API version, e.g. /v26.0/...); ad account ids are masked
    calls = (await sql`select count(*) filter (where ok)::int as ok, count(*)::int as total from api_log where at > now() - interval '15 days' and endpoint like '/v%'`)[0];
    calls.byEndpoint = await sql`select regexp_replace(regexp_replace(endpoint,'act_[0-9]+','act_*','g'),'/[0-9]{6,}','/*','g') as endpoint, count(*) filter (where ok)::int as ok, count(*)::int as total
      from api_log where at > now() - interval '15 days' and endpoint like '/v%' group by 1 order by 3 desc limit 20`;
    // Google, Snapchat and TikTok calls (endpoint names like 'google:campaigns'), with the latest error text
    calls.otherPlatforms = await sql`select split_part(endpoint, ':', 1) as platform, count(*) filter (where ok)::int as ok, count(*)::int as total,
        (array_agg(left(coalesce(err, ''), 160) order by at desc) filter (where not ok))[1] as last_error
      from api_log where at > now() - interval '30 days' and endpoint ~ '^(google|snap|tiktok):' group by 1`;
    calls.connections = (await sql`select (select count(*) from meta_connections)::int as meta, (select count(*) from google_connections)::int as google, (select count(*) from snap_connections)::int as snap, (select count(*) from tiktok_connections)::int as tiktok`)[0];
  } catch (e) { db = 'error: ' + String(e.message).slice(0, 120); }
  const googleMissing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_ADS_DEVELOPER_TOKEN'].filter(k => !process.env[k]);
  const snapMissing = ['SNAP_CLIENT_ID', 'SNAP_CLIENT_SECRET', 'SNAP_REDIRECT_URI'].filter(k => !process.env[k]);
  const tiktokMissing = ['TIKTOK_APP_ID', 'TIKTOK_APP_SECRET', 'TIKTOK_REDIRECT_URI'].filter(k => !process.env[k]);
  return json(res, missing.length || db !== 'ok' ? 500 : 200, { ok: !missing.length && db === 'ok', missing, googleMissing, snapMissing, tiktokMissing, emailOn: !!process.env.RESEND_API_KEY, stripeWebhook: !!process.env.STRIPE_WEBHOOK_SECRET, db, users, metaCallsLast15Days: calls, graph: process.env.META_GRAPH_VERSION || null });
}
