// TikTok Business (Marketing) API v1.3 helpers. Read-only use: account info and reports.
import { sql, encrypt, decrypt } from './core.js';
export const TT = 'https://business-api.tiktok.com/open_api/v1.3';

async function ttFetch(url, init) {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code !== undefined && j.code !== 0)) {
    const e = new Error(j.message || `TikTok returned ${r.status}`); e.code = j.code; e.status = r.status; throw e;
  }
  return j.data || {};
}
export const ttPost = (path, body) => ttFetch(`${TT}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export function ttGet(token, path, params = {}) {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return ttFetch(`${TT}${path}?${q}`, { headers: { 'Access-Token': token } });
}
const creds = () => ({ app_id: process.env.TIKTOK_APP_ID, secret: process.env.TIKTOK_APP_SECRET });
export const exchangeCode = auth_code => ttPost('/oauth2/access_token/', { ...creds(), auth_code });

// Saves tokens; TikTok may return a long-lived token (no expiry) or a 24h token with a refresh token.
export async function saveTokens(userId, d) {
  const exp = d.expires_in ? new Date(Date.now() + (d.expires_in - 300) * 1000).toISOString() : null;
  await sql`insert into tiktok_connections(user_id,token_enc,refresh_enc,expires_at) values(${userId},${encrypt(d.access_token)},${d.refresh_token ? encrypt(d.refresh_token) : null},${exp})
    on conflict(user_id) do update set token_enc=excluded.token_enc,refresh_enc=coalesce(excluded.refresh_enc,tiktok_connections.refresh_enc),expires_at=excluded.expires_at,updated_at=now()`;
}
export async function tokenFor(userId) {
  const r = await sql`select token_enc,refresh_enc,expires_at from tiktok_connections where user_id=${userId}`;
  if (!r[0]) return null;
  const c = r[0];
  if (c.expires_at && new Date(c.expires_at) < new Date() && c.refresh_enc) {
    const d = await ttPost('/oauth2/refresh_token/', { ...creds(), grant_type: 'refresh_token', refresh_token: decrypt(c.refresh_enc) });
    await saveTokens(userId, d);
    return d.access_token;
  }
  return decrypt(c.token_enc);
}
export async function advertisers(token, idsFromExchange = []) {
  let list = [];
  try { list = (await ttGet(token, '/oauth2/advertiser/get/', creds())).list || []; } catch { list = []; }
  const ids = [...new Set([...list.map(a => String(a.advertiser_id)), ...idsFromExchange.map(String)])];
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    let info = [];
    try { info = (await ttGet(token, '/advertiser/info/', { advertiser_ids: ids.slice(i, i + 100), fields: ['advertiser_id', 'name', 'currency', 'timezone', 'display_timezone', 'status'] })).list || []; } catch {}
    for (const id of ids.slice(i, i + 100)) {
      const a = info.find(x => String(x.advertiser_id) === id) || {}, l = list.find(x => String(x.advertiser_id) === id) || {};
      out.push({ id, name: a.name || l.advertiser_name || `Advertiser ${id}`, currency: a.currency || null, tz: validTz(a.display_timezone) || validTz(a.timezone) || null, status: a.status || null });
    }
  }
  return out;
}
export function validTz(tz) { try { if (!tz) return null; new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return null; } }
