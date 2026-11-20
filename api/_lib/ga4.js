import crypto from 'node:crypto';
import { aiOf } from './ai-visits.js';

// Reads a client's Google Analytics 4 property through OptiROAS's service account.
// The client adds the service account's email as a Viewer on their property; no Google sign-in is involved.
// GA_SERVICE_ACCOUNT_JSON = the service account's JSON key (Vercel, sensitive).
function sa() {
  try { const j = JSON.parse(process.env.GA_SERVICE_ACCOUNT_JSON || ''); return j.client_email && j.private_key ? j : null; } catch { return null; }
}
export const gaEmail = () => (sa() || {}).client_email || null;

let tok = null;
async function token() {
  if (tok && tok.exp > Date.now() + 60e3) return tok.access;
  const k = sa(); if (!k) { const e = new Error('Google Analytics connection is not set up yet.'); e.code = 'setup'; throw e; }
  const now = Math.floor(Date.now() / 1000), b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: k.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const jwt = `${unsigned}.${crypto.createSign('RSA-SHA256').update(unsigned).sign(k.private_key, 'base64url')}`;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google sign-in for the service account failed: ' + (j.error_description || j.error || r.status));
  tok = { access: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tok.access;
}

// for the health check: can the service account sign in to Google?
export async function gaReady() { await token(); return gaEmail(); }

export const cleanProperty = p => String(p || '').replace(/^properties\//, '').replace(/\D/g, '');

async function runReport(property, body) {
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`, {
    method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = (j.error && j.error.message) || `Google Analytics returned ${r.status}`, e = new Error(m);
    e.code = r.status === 403 ? 'access' : r.status === 404 || /not found|invalid/i.test(m) ? 'property' : 'ga'; throw e;
  }
  return j;
}

const ymd = d => d.toISOString().slice(0, 10);
// Last 28 full days by session source / medium, in the same shape as a CSV upload (see ai-visits.js)
export async function pullGa4(property, days = 28) {
  property = cleanProperty(property);
  if (!property) { const e = new Error('Enter your GA4 property ID (a number like 312345678).'); e.code = 'property'; throw e; }
  const end = new Date(Date.now() - 864e5), start = new Date(end - (days - 1) * 864e5);
  const metrics = ['sessions', 'engagedSessions', 'keyEvents', 'totalRevenue', 'ecommercePurchases'];
  const j = await runReport(property, { dateRanges: [{ startDate: ymd(start), endDate: ymd(end) }], dimensions: [{ name: 'sessionSourceMedium' }],
    metrics: metrics.map(name => ({ name })), limit: 10000 });
  const tot = { sessions: 0, engaged: 0, keyEvents: 0, revenue: 0, purchases: 0 }, by = new Map();
  for (const row of j.rows || []) {
    const src = row.dimensionValues[0].value, m = row.metricValues.map(v => +v.value || 0);
    const v = { sessions: m[0], engaged: m[1], keyEvents: m[2], revenue: m[3], purchases: m[4] };
    for (const k in tot) tot[k] += v[k];
    const ai = aiOf(src); if (!ai) continue;
    const a = by.get(ai) || { name: ai, sessions: 0, engaged: 0, keyEvents: 0, revenue: 0, purchases: 0, sources: [] };
    for (const k in v) a[k] += v[k];
    if (!a.sources.includes(src) && a.sources.length < 5) a.sources.push(src);
    by.set(ai, a);
  }
  const assistants = [...by.values()].sort((a, b) => b.sessions - a.sessions);
  const ai = assistants.reduce((s, a) => { for (const k in tot) s[k] += a[k]; return s; }, { sessions: 0, engaged: 0, keyEvents: 0, revenue: 0, purchases: 0 });
  return { start: ymd(start), end: ymd(end), total: tot, ai, assistants, has: { engaged: true, keyEvents: true, revenue: true, purchases: true }, daily: [], source: 'ga4' };
}
