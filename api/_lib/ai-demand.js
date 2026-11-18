import { sql, decrypt } from './core.js';
import { GADS, accessFromRefresh } from './google.js';
import { COUNTRIES } from './ai.js';

// Section 2: monthly Google search demand for a brand's keywords, from Google Ads Keyword Planner.
// It runs through OptiROAS's own Google Ads account (GOOGLE_KP_EMAIL = the OptiROAS user whose Google
// connection to use, GOOGLE_KP_CUSTOMER_ID = that Google Ads account), so clients don't connect anything.
const LANG = { ar: 1019, en: 1000 };
export const isAr = s => /[؀-ۿ]/.test(String(s));

async function kpAccount() {
  const email = String(process.env.GOOGLE_KP_EMAIL || '').toLowerCase(), cid = String(process.env.GOOGLE_KP_CUSTOMER_ID || '').replace(/-/g, '');
  if (!email || !cid) { const e = new Error('Keyword data is not set up yet (GOOGLE_KP_EMAIL and GOOGLE_KP_CUSTOMER_ID).'); e.code = 'setup'; throw e; }
  const r = (await sql`select c.token_enc, a.login_customer_id from users u join google_connections c on c.user_id=u.id
    left join google_ad_accounts a on a.user_id=u.id and a.customer_id=${cid} where lower(u.email)=${email}`)[0];
  if (!r) { const e = new Error(`${email} has no Google Ads connection in OptiROAS. Sign in as that user and connect Google Ads.`); e.code = 'setup'; throw e; }
  return { access: await accessFromRefresh(decrypt(r.token_enc)), cid, login: r.login_customer_id };
}
async function call(acc, method, body) {
  const h = { Authorization: `Bearer ${acc.access}`, 'Content-Type': 'application/json', 'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '' };
  if (acc.login) h['login-customer-id'] = String(acc.login).replace(/-/g, '');
  const r = await fetch(`${GADS()}/customers/${acc.cid}:${method}`, { method: 'POST', headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = j.error || {}, det = (((d.details || [])[0] || {}).errors || [])[0] || {};
    const e = new Error(det.message || d.message || `Google Ads returned ${r.status}`); e.code = det.errorCode ? Object.values(det.errorCode)[0] : d.status; throw e;
  }
  return j;
}
const MON = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const metrics = m => m ? {
  avg: m.avgMonthlySearches != null ? +m.avgMonthlySearches : null, competition: m.competition || null,
  low: m.lowTopOfPageBidMicros ? +m.lowTopOfPageBidMicros / 1e6 : null, high: m.highTopOfPageBidMicros ? +m.highTopOfPageBidMicros / 1e6 : null,
  months: (m.monthlySearchVolumes || []).map(v => ({ m: `${v.year}-${String(MON.indexOf(v.month) + 1).padStart(2, '0')}`, n: +v.monthlySearches || 0 })).sort((a, b) => a.m < b.m ? -1 : 1)
} : null;

// keywords: [text], country: 'SA'. Returns { keywords:[{text, lang, ...metrics}], ideas:[...] }
export async function demand(keywords, country, seed) {
  const acc = await kpAccount(), geo = `geoTargetConstants/${(COUNTRIES[country] || COUNTRIES.SA).geo}`, out = [], ideas = [];
  for (const lang of ['ar', 'en']) {
    const ks = keywords.filter(k => (lang === 'ar') === isAr(k));
    if (!ks.length) continue;
    const j = await call(acc, 'generateKeywordHistoricalMetrics', { keywords: ks, geoTargetConstants: [geo], language: `languageConstants/${LANG[lang]}`, keywordPlanNetwork: 'GOOGLE_SEARCH', historicalMetricsOptions: { includeAverageCpc: true } });
    const got = new Map((j.results || []).map(r => [String(r.text).toLowerCase(), r]));
    for (const k of ks) {
      const r = got.get(k.toLowerCase()) || (j.results || []).find(x => (x.closeVariants || []).some(v => v.toLowerCase() === k.toLowerCase()));
      out.push({ text: k, lang, ...(metrics(r && r.keywordMetrics) || { avg: 0, months: [] }) });
    }
  }
  if (seed && seed.length) {
    try {
      const lang = isAr(seed[0]) ? 'ar' : 'en';
      const j = await call(acc, 'generateKeywordIdeas', { keywordSeed: { keywords: seed.slice(0, 10) }, geoTargetConstants: [geo], language: `languageConstants/${LANG[lang]}`, keywordPlanNetwork: 'GOOGLE_SEARCH', pageSize: 25 });
      for (const r of j.results || []) if (!keywords.some(k => k.toLowerCase() === String(r.text).toLowerCase())) ideas.push({ text: r.text, ...metrics(r.keywordIdeaMetrics) });
    } catch (e) { /* ideas are optional */ }
  }
  return { keywords: out, ideas: ideas.sort((a, b) => (b.avg || 0) - (a.avg || 0)).slice(0, 20) };
}
