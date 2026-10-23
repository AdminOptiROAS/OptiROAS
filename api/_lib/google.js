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

// Finds the Google Ads accounts a login can reach (expanding manager accounts one level).
// Returns the accounts plus a plain-English note when none could be read, so the UI can say why.
export async function discover(access, log) {
  const ids = await listAccessible(access); await log('google:listAccessibleCustomers', true);
  if (!ids.length) return { accts: [], note: 'This Google login has no Google Ads accounts. Sign in with the Google account that has access to your ads, or ask the account owner to add this email in Google Ads (Admin → Access and security).' };
  const accts = new Map(), errs = [];
  for (const id of ids.slice(0, 50)) {
    try {
      const [c] = await gaql(access, id, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1');
      await log('google:customer', true);
      if (!c) continue;
      if (c.customer.manager) {
        const kids = await gaql(access, id, 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.level <= 1 AND customer_client.manager = FALSE', id);
        await log('google:customer_client', true);
        for (const k of kids) { const cc = k.customerClient; if (cc.status && cc.status !== 'ENABLED') continue;
          if (!accts.has(String(cc.id))) accts.set(String(cc.id), { id: String(cc.id), name: cc.descriptiveName, currency: cc.currencyCode, tz: cc.timeZone, login: String(id) }); }
      } else if (!c.customer.status || c.customer.status === 'ENABLED') {
        accts.set(String(c.customer.id), { id: String(c.customer.id), name: c.customer.descriptiveName, currency: c.customer.currencyCode, tz: c.customer.timeZone, login: null });
      } else errs.push(`${id}: account is ${String(c.customer.status).toLowerCase()}`);
    } catch (e) { await log('google:customer', false); errs.push(`${id}: ${e.message}`); console.error('google customer', id, e.status, e.code, e.message); }
  }
  const note = accts.size ? null : `Google found ${ids.length} account${ids.length === 1 ? '' : 's'} for this login but none could be read. ${errs.slice(0, 2).join(' · ')}`.slice(0, 400);
  return { accts: [...accts.values()], note };
}
