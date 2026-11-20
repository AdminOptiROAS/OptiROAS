import { ensureSchema, sql, json } from './_lib/core.js';
import { ENGINES, enginesOn } from './_lib/ai.js';
import { demand } from './_lib/ai-demand.js';

// ?ai=1: one tiny live call per AI assistant and one Keyword Planner lookup, at most once every 10 minutes (results cached)
let aiCheck = null;
async function checkAi() {
  if (aiCheck && Date.now() - aiCheck.at < 10 * 60e3) return { ...aiCheck, cached: true };
  const out = { at: Date.now(), engines: {}, keywordPlanner: null };
  await Promise.all(Object.keys(ENGINES).map(async k => {
    if (!process.env[ENGINES[k].key]) { out.engines[k] = 'no key'; return; }
    try { const r = await ENGINES[k].ask('Name one well-known perfume shop in Riyadh. One line.', 'SA'); out.engines[k] = r.text ? `ok (${r.cites.length} sources)` : 'empty answer'; }
    catch (e) { out.engines[k] = 'error: ' + String(e.message).slice(0, 160); }
  }));
  try { const d = await demand(['عطر عود'], 'SA'); out.keywordPlanner = `ok (عطر عود: ${d.keywords[0] ? d.keywords[0].avg : '?'} searches/month in Saudi Arabia)`; }
  catch (e) { out.keywordPlanner = 'error: ' + String(e.message).slice(0, 200); }
  aiCheck = out; return out;
}

// Reports whether the server, database and required settings are in place (no secrets returned).
export default async function handler(req, res) {
  if (/[?&]ai=1/.test(req.url || '')) return json(res, 200, { ai: await checkAi(), on: enginesOn() });
  const need = ['DATABASE_URL', 'ENCRYPTION_KEY', 'META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID', 'META_REDIRECT_URI'];
  const missing = need.filter(k => !process.env[k]);
  let db = 'ok', users = null, calls = null;
  try {
    await ensureSchema();
    users = (await sql`select count(*)::int as n from users`)[0].n;
    // Meta Graph calls only (paths start with the API version, e.g. /v26.0/...); ad account ids are masked
    calls = (await sql`select count(*) filter (where ok)::int as ok, count(*)::int as total from api_log where at > now() - interval '15 days' and endpoint like '/v%'`)[0];
    calls.byEndpoint = await sql`select regexp_replace(regexp_replace(endpoint,'act_[0-9]+','act_*','g'),'/[0-9]{6,}','/*','g') as endpoint, count(*) filter (where ok)::int as ok, count(*)::int as total,
        (array_agg(left(regexp_replace(coalesce(err,''),'act_[0-9]+|[0-9]{8,}','*','g'),160) order by at desc) filter (where not ok))[1] as last_error
      from api_log where at > now() - interval '15 days' and endpoint like '/v%' group by 1 order by 3 desc limit 20`;
    // Google, Snapchat and TikTok calls (endpoint names like 'google:campaigns'), with the latest error text
    calls.otherPlatforms = await sql`select split_part(endpoint, ':', 1) as platform, count(*) filter (where ok)::int as ok, count(*)::int as total,
        (array_agg(left(coalesce(err, ''), 160) order by at desc) filter (where not ok))[1] as last_error
      from api_log where at > now() - interval '30 days' and endpoint ~ '^(google|snap|tiktok|salla):' group by 1`;
    // per endpoint, so a failing step (token, account list, one closed account) is visible on its own
    calls.otherByEndpoint = await sql`select endpoint, count(*) filter (where ok)::int as ok, count(*)::int as total,
        (array_agg(left(regexp_replace(coalesce(err, ''), '[0-9]{8,}', '*', 'g'), 160) order by at desc) filter (where not ok))[1] as last_error,
        max(at) as last_at
      from api_log where at > now() - interval '30 days' and endpoint ~ '^(google|snap|tiktok|salla):' group by 1 order by 1`;
    calls.connections = (await sql`select (select count(*) from meta_connections)::int as meta, (select count(*) from google_connections)::int as google, (select count(*) from snap_connections)::int as snap, (select count(*) from tiktok_connections)::int as tiktok`)[0];
  } catch (e) { db = 'error: ' + String(e.message).slice(0, 120); }
  // Google Ads developer tokens were retired on 9 Sep 2026; access comes from the Cloud project's access level
  const googleMissing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'].filter(k => !process.env[k]);
  const snapMissing = ['SNAP_CLIENT_ID', 'SNAP_CLIENT_SECRET', 'SNAP_REDIRECT_URI'].filter(k => !process.env[k]);
  const sallaMissing = ['SALLA_CLIENT_ID', 'SALLA_CLIENT_SECRET', 'SALLA_WEBHOOK_SECRET', (process.env.SALLA_MODE || 'custom') === 'easy' ? 'SALLA_APP_ID' : 'SALLA_REDIRECT_URI'].filter(k => !process.env[k]);
  const tiktokMissing = ['TIKTOK_APP_ID', 'TIKTOK_APP_SECRET', 'TIKTOK_REDIRECT_URI'].filter(k => !process.env[k]);
  return json(res, missing.length || db !== 'ok' ? 500 : 200, { ok: !missing.length && db === 'ok', missing, googleMissing, snapMissing, tiktokMissing, sallaMissing, sallaMode: process.env.SALLA_MODE || 'custom', emailOn: !!process.env.RESEND_API_KEY, stripeWebhook: !!process.env.STRIPE_WEBHOOK_SECRET, db, users, metaCallsLast15Days: calls, graph: process.env.META_GRAPH_VERSION || null });
}
