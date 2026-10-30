// Shared helpers for OptiROAS server functions: database, sessions, encryption, Meta Graph calls.
import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

export const sql = neon(process.env.DATABASE_URL);
const GRAPH = () => `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v26.0'}`;

/* ---------- schema (idempotent; runs once per cold start) ---------- */
let schemaReady;
export function ensureSchema() {
  if (!schemaReady) schemaReady = (async () => {
    await sql`create table if not exists users(
      id uuid primary key default gen_random_uuid(),
      email text unique not null, name text, pass_hash text not null,
      created_at timestamptz not null default now())`;
    await sql`create table if not exists sessions(
      token_hash text primary key, user_id uuid not null references users(id) on delete cascade,
      expires_at timestamptz not null, created_at timestamptz not null default now())`;
    await sql`create table if not exists meta_connections(
      user_id uuid primary key references users(id) on delete cascade,
      meta_id text, meta_name text, client_business_id text,
      token_enc text not null, connected_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
    await sql`create table if not exists meta_ad_accounts(
      user_id uuid not null references users(id) on delete cascade,
      account_id text not null, name text, currency text, timezone text, status int,
      primary key(user_id, account_id))`;
    await sql`create table if not exists google_connections(
      user_id uuid primary key references users(id) on delete cascade,
      google_email text, token_enc text not null,
      connected_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
    await sql`create table if not exists google_ad_accounts(
      user_id uuid not null references users(id) on delete cascade,
      customer_id text not null, name text, currency text, timezone text, login_customer_id text,
      primary key(user_id, customer_id))`;
    await sql`create table if not exists snap_connections(
      user_id uuid primary key references users(id) on delete cascade,
      snap_email text, snap_name text, token_enc text not null,
      connected_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
    await sql`create table if not exists snap_ad_accounts(
      user_id uuid not null references users(id) on delete cascade,
      account_id text not null, name text, org_name text, currency text, timezone text,
      primary key(user_id, account_id))`;
    await sql`create table if not exists tiktok_connections(
      user_id uuid primary key references users(id) on delete cascade,
      token_enc text not null, refresh_enc text, expires_at timestamptz,
      connected_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
    await sql`create table if not exists tiktok_ad_accounts(
      user_id uuid not null references users(id) on delete cascade,
      account_id text not null, name text, currency text, timezone text,
      primary key(user_id, account_id))`;
    await sql`alter table google_connections add column if not exists note text`;
    await sql`create table if not exists saved_reports(
      id uuid primary key default gen_random_uuid(), user_id uuid not null references users(id) on delete cascade,
      label text, period text, currency text, score int, data jsonb not null, lang text,
      followup_at timestamptz, followup_sent_at timestamptz, created_at timestamptz not null default now())`;
    await sql`create index if not exists saved_reports_user on saved_reports(user_id, created_at desc)`;
    await sql`create table if not exists feedback(
      id bigserial primary key, user_id uuid, email text, rating int, message text, page text, lang text, ua text,
      created_at timestamptz not null default now())`;
    await sql`alter table users add column if not exists plan text not null default 'free'`;
    await sql`alter table users add column if not exists stripe_customer_id text`;
    await sql`alter table users add column if not exists vertical text`;
    await sql`alter table api_log add column if not exists err text`;
    await sql`alter table users add column if not exists email_verified_at timestamptz`;
    await sql`create table if not exists user_tokens(
      token_hash text primary key, user_id uuid not null references users(id) on delete cascade,
      kind text not null, expires_at timestamptz not null, used_at timestamptz, created_at timestamptz not null default now())`;
    await sql`create table if not exists usage_reports(
      id bigserial primary key, user_id uuid not null references users(id) on delete cascade,
      month text not null, fp text, at timestamptz not null default now())`;
    await sql`create index if not exists usage_reports_user_month on usage_reports(user_id, month)`;
    await sql`create table if not exists usage_downloads(
      id bigserial primary key, user_id uuid not null references users(id) on delete cascade,
      month text not null, kind text not null, at timestamptz not null default now())`;
    await sql`alter table usage_downloads add column if not exists ref text`;
    // Pay-per-audit: credits bought with the one-time $14.99 payment link, and the reports they unlocked
    await sql`alter table users add column if not exists audit_credits int not null default 0`;
    await sql`create table if not exists audit_unlocks(
      user_id uuid not null references users(id) on delete cascade, fp text not null,
      at timestamptz not null default now(), primary key(user_id, fp))`;
    await sql`create table if not exists audit_payments(
      session_id text primary key, user_id uuid, amount int, at timestamptz not null default now())`;
    // free audits confirmed before paid audits launched stay unlocked
    await sql`insert into audit_unlocks(user_id, fp, at) select user_id, fp, min(at) from usage_reports
      where fp is not null and at < '2026-10-30T12:00:00Z' group by user_id, fp on conflict do nothing`;
    await sql`create table if not exists api_log(
      id bigserial primary key, user_id uuid, endpoint text, ok boolean, at timestamptz not null default now())`;
  })().catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

/* ---------- http helpers ---------- */
export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
export function cookies(req) {
  const out = {};
  for (const p of (req.headers.cookie || '').split(';')) {
    const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}
export function setCookie(res, name, value, maxAgeSec) {
  const c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}
export function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}
export const emailOk = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 200;

/* ---------- passwords ---------- */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function checkPassword(pw, stored) {
  const [alg, s, k] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(k, 'base64');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}

/* ---------- sessions ---------- */
const SESSION_DAYS = 30;
export const sha = t => crypto.createHash('sha256').update(t).digest('hex');
export async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await sql`insert into sessions(token_hash,user_id,expires_at) values(${sha(token)},${userId},now()+${SESSION_DAYS + ' days'}::interval)`;
  setCookie(res, 'or_session', token, SESSION_DAYS * 86400);
}
export async function currentUser(req) {
  const t = cookies(req).or_session; if (!t) return null;
  await ensureSchema();
  const r = await sql`select u.id,u.email,u.name,u.plan,u.email_verified_at,u.vertical from sessions s join users u on u.id=s.user_id
    where s.token_hash=${sha(t)} and s.expires_at>now()`;
  return r[0] || null;
}
export async function endSession(req, res) {
  const t = cookies(req).or_session;
  if (t) await sql`delete from sessions where token_hash=${sha(t)}`;
  setCookie(res, 'or_session', '', 0);
}

/* ---------- token encryption (AES-256-GCM) ---------- */
function encKey() {
  const k = Buffer.from(process.env.ENCRYPTION_KEY || '', 'base64');
  if (k.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return k;
}
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}
export function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split('.');
  if (v !== 'v1') throw new Error('Unknown token format');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

/* ---------- Meta Graph ---------- */
export async function graph(path, params = {}, { userId, method = 'GET' } = {}) {
  const url = new URL(path.startsWith('http') ? path : GRAPH() + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  let r, j;
  try { r = await fetch(url, { method }); j = await r.json(); }
  catch (e) { await logCall(userId, url.pathname, false, 'network: ' + e.message); throw new Error('Could not reach Meta. Try again in a moment.'); }
  await logCall(userId, url.pathname, r.ok && !j.error, j && j.error ? `${j.error.code || r.status}${j.error.error_subcode ? '/' + j.error.error_subcode : ''} ${j.error.type || ''}: ${j.error.message || ''}` : null);
  if (!r.ok || j.error) {
    const e = new Error(j?.error?.message || `Meta returned ${r.status}`);
    e.meta = j?.error; e.status = r.status; throw e;
  }
  return j;
}
async function logCall(userId, endpoint, ok, err) {
  try { await sql`insert into api_log(user_id,endpoint,ok,err) values(${userId || null},${String(endpoint).slice(0, 200)},${ok},${err ? String(err).slice(0, 300) : null})`; } catch {}
}
export async function logApi(userId, endpoint, ok, err) { return logCall(userId, endpoint, ok, err); }
export async function metaToken(userId) {
  const r = await sql`select token_enc from meta_connections where user_id=${userId}`;
  return r[0] ? decrypt(r[0].token_enc) : null;
}
export const appSecretProof = token => crypto.createHmac('sha256', process.env.META_APP_SECRET).update(token).digest('hex');
