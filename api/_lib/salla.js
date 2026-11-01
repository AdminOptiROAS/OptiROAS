import crypto from 'node:crypto';
import { sql, encrypt, decrypt, logApi } from './core.js';
import { canConnect } from './plan.js';

// Salla (store orders) through the Salla Partners app. Read-only: orders.read (+ offline_access for a refresh token).
// Two ways a store gets linked:
//  - Custom mode (testing on demo stores): the usual redirect with ?code, exchanged here.
//  - Easy mode (required for apps published on the Salla App Store): the merchant installs the app and Salla
//    sends the tokens to our webhook as app.store.authorize; we link that store to the OptiROAS user who asked to connect.
// Salla rules: access tokens last 14 days, refresh tokens one month and are single-use (reusing one revokes access).
export const SALLA_AUTH = 'https://accounts.salla.sa/oauth2';
export const SALLA_API = process.env.SALLA_API_BASE || 'https://api.salla.dev/admin/v2';
export const sallaMode = () => (process.env.SALLA_MODE || 'custom').toLowerCase() === 'easy' ? 'easy' : 'custom';
export const sallaReady = () => !!(process.env.SALLA_CLIENT_ID && process.env.SALLA_CLIENT_SECRET &&
  (sallaMode() === 'easy' ? process.env.SALLA_APP_ID : process.env.SALLA_REDIRECT_URI));
// Store connections follow the ad-account rule (Starter, Pro, team and reviewers); SALLA_AUDIT_PLAN=1 opens it to the Audit plan
export const canConnectStore = u => !!u && (canConnect(u) || (process.env.SALLA_AUDIT_PLAN === '1' && u.plan === 'audit'));

export async function sallaToken(params) {
  const r = await fetch(`${SALLA_AUTH}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: process.env.SALLA_CLIENT_ID, client_secret: process.env.SALLA_CLIENT_SECRET, ...params })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { const e = new Error(j.error_description || j.message || j.error || `Salla returned ${r.status}`); e.code = j.error; e.status = r.status; throw e; }
  return j;
}

export async function sallaUserInfo(access) {
  const r = await fetch(`${SALLA_AUTH}/user/info`, { headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error && j.error.message || j.message || `Salla returned ${r.status}`);
  const d = j.data || j;
  const m = d.merchant || {};
  return { merchantId: String(m.id || d.merchant_id || ''), storeName: m.name || m.username || null, domain: m.domain || null, email: String(d.email || '').toLowerCase() || null };
}

// expires: Salla sends seconds-from-now (token response) or a unix timestamp (webhook); accept both
export const expiry = e => { const n = Number(e) || 0; if (!n) return new Date(Date.now() + 13 * 864e5); return new Date(n > 1e9 ? n * 1000 : Date.now() + n * 1000); };

export async function saveConnection(userId, tok, info) {
  await sql`delete from salla_connections where merchant_id=${info.merchantId} and user_id<>${userId}`;
  await sql`insert into salla_connections(user_id, merchant_id, store_name, store_domain, store_email, access_enc, refresh_enc, expires_at, scope)
    values(${userId}, ${info.merchantId}, ${info.storeName}, ${info.domain}, ${info.email}, ${encrypt(tok.access_token)}, ${tok.refresh_token ? encrypt(tok.refresh_token) : null}, ${expiry(tok.expires || tok.expires_in)}, ${tok.scope || null})
    on conflict(user_id) do update set merchant_id=excluded.merchant_id, store_name=excluded.store_name, store_domain=excluded.store_domain, store_email=excluded.store_email,
      access_enc=excluded.access_enc, refresh_enc=excluded.refresh_enc, expires_at=excluded.expires_at, scope=excluded.scope, updated_at=now()`;
  await sql`delete from salla_installs where merchant_id=${info.merchantId}`;
  await sql`delete from salla_pending where user_id=${userId}`;
}

// A valid access token for this user's store, refreshing it (once, with a compare-and-swap) when it is about to expire.
export async function sallaAccess(userId) {
  const c = (await sql`select * from salla_connections where user_id=${userId}`)[0];
  if (!c) { const e = new Error('Connect your Salla store first.'); e.code = 'not_connected'; throw e; }
  if (new Date(c.expires_at) - Date.now() > 36e5 || !c.refresh_enc) return { access: decrypt(c.access_enc), conn: c };
  let tok;
  try { tok = await sallaToken({ grant_type: 'refresh_token', refresh_token: decrypt(c.refresh_enc) }); await logApi(userId, 'salla:refresh', true); }
  catch (e) {
    await logApi(userId, 'salla:refresh', false, String(e.message).slice(0, 200));
    // another request may have refreshed it a moment ago: use the newer token if there is one
    const n = (await sql`select * from salla_connections where user_id=${userId}`)[0];
    if (n && n.refresh_enc !== c.refresh_enc) return { access: decrypt(n.access_enc), conn: n };
    const x = new Error('Salla asked for the store to be connected again. Reconnect Salla in My account.'); x.code = 'reconnect'; throw x;
  }
  const upd = await sql`update salla_connections set access_enc=${encrypt(tok.access_token)}, refresh_enc=${tok.refresh_token ? encrypt(tok.refresh_token) : c.refresh_enc},
      expires_at=${expiry(tok.expires || tok.expires_in)}, updated_at=now() where user_id=${userId} and refresh_enc=${c.refresh_enc} returning *`;
  if (upd[0]) return { access: tok.access_token, conn: upd[0] };
  const n = (await sql`select * from salla_connections where user_id=${userId}`)[0];
  return { access: decrypt(n.access_enc), conn: n };
}

export async function sallaGet(userId, access, path, params) {
  const url = `${SALLA_API}${path}${params ? '?' + new URLSearchParams(params) : ''}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' } });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (attempt + 1))); continue; }
    const j = await r.json().catch(() => ({}));
    const ok = r.ok && j.success !== false;
    await logApi(userId, 'salla:' + path.split('?')[0].replace(/\/\d+/g, '/*'), ok, ok ? null : `${r.status} ${(j.error && (j.error.message || j.error.code)) || j.message || ''}`.slice(0, 200));
    if (!ok) { const e = new Error((j.error && j.error.message) || j.message || `Salla returned ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  throw new Error('Salla is busy right now. Try again in a minute.');
}

// Salla order statuses → the words the delivered-ROAS reader understands
const STATUS = s => {
  const v = String(s || '').toLowerCase();
  if (/restor|return|refund/.test(v)) return 'returned';
  if (/cancel/.test(v)) return 'canceled';
  if (/deliver|complet/.test(v)) return 'delivered';
  return v || 'pending';
};
const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const pick = (o, ...ks) => { for (const k of ks) { const v = k.split('.').reduce((a, p) => a && a[p], o); if (v != null && v !== '') return v; } return ''; };

// Orders created between from and to (YYYY-MM-DD), as a CSV the site reads like an uploaded store export
export async function sallaOrdersCsv(userId, from, to) {
  const { access, conn } = await sallaAccess(userId);
  const rows = [['Order ID', 'Created At', 'Total', 'Order Status', 'Payment Method', 'UTM Source', 'UTM Campaign', 'Currency']];
  let cur = null, page = 1, pages = 1, n = 0;
  const t0 = Date.now();
  do {
    const j = await sallaGet(userId, access, '/orders', { from_date: from, to_date: to, page: String(page), per_page: '65' });
    for (const o of (j.data || [])) {
      const total = pick(o, 'total.amount', 'amounts.total.amount', 'total');
      const c = pick(o, 'total.currency', 'amounts.total.currency', 'currency');
      if (c && !cur) cur = String(c).toUpperCase();
      const date = String(pick(o, 'date.date', 'created_at', 'date')).slice(0, 10);
      rows.push([pick(o, 'reference_id', 'id'), date, total, STATUS(pick(o, 'status.slug', 'status.name', 'status')),
        pick(o, 'payment_method', 'payment.method'), pick(o, 'source_details.utm_source', 'utm.source', 'source_details.type', 'source'),
        pick(o, 'source_details.utm_campaign', 'utm.campaign'), c].map(csvCell));
      n++;
    }
    const pg = j.pagination || {};
    pages = Number(pg.totalPages || pg.total_pages || 1);
    page++;
  } while (page <= pages && page <= 150 && Date.now() - t0 < 50e3);
  const partial = page <= pages;
  await sql`update salla_connections set last_import_at=now() where user_id=${userId}`;
  return { csv: rows.map(r => r.join(',')).join('\n'), count: n, currency: cur, store: conn.store_name, partial };
}

// Webhook signature: HMAC-SHA256 of the raw body with the app's webhook secret (Signature strategy), or the secret itself (Token strategy)
export function sallaVerify(raw, headers) {
  const secret = process.env.SALLA_WEBHOOK_SECRET;
  if (!secret) return false;
  const strategy = String(headers['x-salla-security-strategy'] || 'signature').toLowerCase();
  const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (strategy === 'token') return eq(String(headers.authorization || '').replace(/^Bearer\s+/i, ''), secret);
  const want = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return eq(String(headers['x-salla-signature'] || ''), want);
}

export const sallaReadyFor = u => sallaReady() && canConnectStore(u);
