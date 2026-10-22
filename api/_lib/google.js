// Google Ads helpers: OAuth token refresh and GAQL search (read-only).
export const GADS = () => `https://googleads.googleapis.com/${process.env.GOOGLE_ADS_API_VERSION || 'v26'}`;
export const SCOPE = 'https://www.googleapis.com/auth/adwords openid email';

export async function tokenRequest(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { const e = new Error(j.error_description || j.error || `Google returned ${r.status}`); e.code = j.error; throw e; }
  return j;
}
export const accessFromRefresh = refresh => tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh }).then(j => j.access_token);

function headers(access, loginCustomerId) {
  const h = { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' };
  if (process.env.GOOGLE_ADS_DEVELOPER_TOKEN) h['developer-token'] = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (loginCustomerId) h['login-customer-id'] = String(loginCustomerId).replace(/-/g, '');
  return h;
}
function gerr(j, status) {
  const d = j && j.error;
  const detail = d && d.details && d.details[0] && d.details[0].errors && d.details[0].errors[0];
  const e = new Error((detail && detail.message) || (d && d.message) || `Google Ads returned ${status}`);
  e.status = status; e.code = detail && detail.errorCode ? Object.values(detail.errorCode)[0] : d && d.status; return e;
}
export async function listAccessible(access) {
  const r = await fetch(`${GADS()}/customers:listAccessibleCustomers`, { headers: headers(access) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw gerr(j, r.status);
  return (j.resourceNames || []).map(s => s.split('/')[1]);
}
// Runs a GAQL query and returns all rows (handles pagination of searchStream batches).
export async function gaql(access, customerId, query, loginCustomerId) {
  const r = await fetch(`${GADS()}/customers/${String(customerId).replace(/-/g, '')}/googleAds:searchStream`, {
    method: 'POST', headers: headers(access, loginCustomerId), body: JSON.stringify({ query })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw gerr(Array.isArray(j) ? j[0] : j, r.status);
  return (Array.isArray(j) ? j : [j]).flatMap(b => b.results || []);
}
