import { ensureSchema, sql, json, currentUser } from '../_lib/core.js';
import { isAdmin } from '../_lib/plan.js';
import { sendMail, mailOn, KITEO_SUPPORT, KITEO_SITE } from '../_lib/mail.js';
import { xlsx } from '../_lib/xlsx.js';

// Daily Kiteo report (vercel.json cron, 08:15 Dubai) to admin@kiteoai.com (KITEO_REPORT_EMAIL to change it).
// Last 24 hours compared with the 24 hours before: traffic on kiteoai.com, everyone who registered interest (accounts, free checks,
// services, Kiteo Commerce waitlist), subscribe clicks, new subscriptions and revenue, cancellations, and product use.
// Attached Excel: summary, 30-day trend, traffic by page and source, every account, every request, every subscription.
// Team, reviewer and tester emails (ADMIN_EMAILS, REVIEW_EMAILS, ALLOWED_EMAILS, AI_VIS_EMAILS) and their browsers are left out.
// Where the data lives: page_views / site_events with site='kiteo'; users (brand='kiteo'); ai_requests; Stripe webhook → site_events k_subscribed / k_cancelled.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uae = d => d ? new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Dubai' }).slice(0, 16) : '';
const list = k => (process.env[k] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const SERVICE = { check: 'Free AI check', reviews: 'Reviews programme', content: 'Content package', listings: 'Listings and placements', commerce: 'Kiteo Commerce waitlist' };
const COUNTRY = { SA: 'Saudi Arabia', AE: 'UAE', KW: 'Kuwait', QA: 'Qatar', BH: 'Bahrain', OM: 'Oman', EG: 'Egypt' };
const PAGE = { khome: 'Home', kfeatures: 'What you get', khow: 'How it works', ksoon: 'Coming soon', kpricing: 'Pricing', kbook: 'Book a free check',
  kprivacy: 'Privacy policy', kterms: 'Terms of use', kdeletion: 'Data deletion', ai: 'Dashboard', account: 'Account', signin: 'Sign in', reset: 'Password reset' };
const one = async q => (await q)[0] || {};
const n0 = v => Number(v) || 0;
const aed = v => 'AED ' + Math.round(n0(v)).toLocaleString('en-US');
const mins = s => { s = Math.round(n0(s)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const delta = (a, b) => { a = n0(a); b = n0(b); if (a === b) return ''; const d = a - b; return `<span style="color:${d > 0 ? '#1a7f4b' : '#c0392b'};font-size:12px"> ${d > 0 ? '▲' : '▼'} ${Math.abs(d)}</span>`; };

export default async function handler(req, res) {
  const cron = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const me = cron ? null : await currentUser(req).catch(() => null);
  if (!cron && !(me && isAdmin(me))) return json(res, 401, { error: 'Unauthorized' });
  await ensureSchema();
  await sql`create table if not exists ai_requests(id bigserial primary key, email text not null, name text, phone text, brand text, website text, country text, lang text, user_id uuid, created_at timestamptz not null default now())`;
  await sql`alter table ai_requests add column if not exists service text`;

  const internal = [...new Set([...list('ADMIN_EMAILS'), ...list('REVIEW_EMAILS'), ...list('ALLOWED_EMAILS'), ...list('AI_VIS_EMAILS')])];
  const ext = internal.length ? internal : ['-'];
  const teamVid0 = (await sql`select distinct pv.vid from page_views pv join users u on u.id=pv.user_id where pv.vid is not null and lower(u.email) = any(${ext})`).map(r => r.vid);
  const tv = teamVid0.length ? teamVid0 : ['-'];

  // Traffic: last 24h and the 24h before
  const traffic = async (from, to) => one(sql`select count(distinct vid)::int as visitors, coalesce(sum(n),0)::int as views, coalesce(sum(secs),0)::int as secs,
      count(distinct vid) filter (where page='kpricing')::int as pricing
    from page_views where coalesce(site,'optiroas')='kiteo' and at > now() - ${from}::interval and at <= now() - ${to}::interval and (vid is null or vid <> all(${tv}))`);
  const t1 = await traffic('24 hours', '0 hours'), t0 = await traffic('48 hours', '24 hours');
  const pages = await sql`select page, coalesce(sum(n),0)::int as views, count(distinct vid)::int as visitors, coalesce(sum(secs),0)::int as secs
    from page_views where coalesce(site,'optiroas')='kiteo' and at > now() - interval '24 hours' and (vid is null or vid <> all(${tv})) group by 1 order by 2 desc, 3 desc limit 15`;
  const sources = await sql`select coalesce(nullif(src,''),'direct / unknown') as src, count(distinct vid)::int as visitors, coalesce(sum(n),0)::int as views
    from page_views where coalesce(site,'optiroas')='kiteo' and at > now() - interval '24 hours' and (vid is null or vid <> all(${tv})) group by 1 order by 2 desc limit 10`;

  // Events from the site and from Stripe
  const evs = async (from, to) => one(sql`select count(*) filter (where ev='k_checkout')::int as clicks, count(*) filter (where ev='k_subscribed')::int as subs,
      coalesce(sum(val) filter (where ev='k_subscribed'),0)::numeric as revenue, count(*) filter (where ev='k_cancelled')::int as cancels
    from site_events where coalesce(site,'optiroas')='kiteo' and at > now() - ${from}::interval and at <= now() - ${to}::interval
      and (user_id is null or user_id not in (select id from users where lower(email) = any(${ext})))`);
  const e1 = await evs('24 hours', '0 hours'), e0 = await evs('48 hours', '24 hours');
  const subsList = await sql`select e.at, e.val, e.detail, u.name, u.email, coalesce(u.company, b.brand) as brand from site_events e left join users u on u.id=e.user_id left join ai_brands b on b.user_id=e.user_id
    where coalesce(e.site,'optiroas')='kiteo' and e.ev in ('k_subscribed','k_cancelled') and (u.email is null or lower(u.email) <> all(${ext})) order by e.at desc limit 5000`;

  // People
  const accounts = await sql`select u.id, u.email, u.name, u.company, u.website, u.lang, u.created_at, u.email_verified_at, u.plan, u.utm_source,
      b.brand as tracked, b.country, (select count(*) from ai_jobs j where j.user_id=u.id and j.status='done')::int as answers
    from users u left join ai_brands b on b.user_id=u.id where u.brand='kiteo' and lower(u.email) <> all(${ext}) order by u.created_at desc limit 20000`;
  const requests = await sql`select r.*, exists(select 1 from users u where u.brand='kiteo' and lower(u.email)=lower(r.email)) as has_account
    from ai_requests r where lower(r.email) <> all(${ext}) order by r.created_at desc limit 20000`;
  const inWin = (x, a, b) => { const age = Date.now() - new Date(x.created_at); return age < a * 3600e3 && age >= b * 3600e3; };
  const newAcc = accounts.filter(a => inWin(a, 24, 0)), prevAcc = accounts.filter(a => inWin(a, 48, 24));
  const newReq = requests.filter(r => inWin(r, 24, 0)), prevReq = requests.filter(r => inWin(r, 48, 24));
  const isWait = r => r.service === 'commerce';
  const newChecks = newReq.filter(r => !isWait(r)), newWait = newReq.filter(isWait);
  const subscribers = accounts.filter(a => a.plan === 'kiteo').length;

  // Product use in the last 24h (customers only)
  const usage = await one(sql`select
      (select count(*) from ai_jobs j join users u on u.id=j.user_id where u.brand='kiteo' and j.status='done' and j.done_at > now() - interval '24 hours' and lower(u.email) <> all(${ext}))::int as answers,
      (select count(distinct j.user_id) from ai_jobs j join users u on u.id=j.user_id where u.brand='kiteo' and j.done_at > now() - interval '24 hours' and lower(u.email) <> all(${ext}))::int as brands_checked,
      (select count(*) from ai_brands b join users u on u.id=b.user_id where u.brand='kiteo' and b.created_at > now() - interval '24 hours' and lower(u.email) <> all(${ext}))::int as brands_new,
      (select count(*) from ai_alerts a join users u on u.id=a.user_id where u.brand='kiteo' and a.created_at > now() - interval '24 hours' and lower(u.email) <> all(${ext}))::int as alerts`);
  let siteChecks = 0;
  try { siteChecks = n0((await one(sql`select count(*)::int as n from ai_site s join users u on u.id=s.user_id where u.brand='kiteo' and s.checked_at > now() - interval '24 hours' and lower(u.email) <> all(${ext})`)).n); } catch { /* table not created yet */ }

  // 30-day trend for the Excel file
  const trend = await sql`with d as (select generate_series((now() at time zone 'Asia/Dubai')::date - 29, (now() at time zone 'Asia/Dubai')::date, '1 day')::date as day)
    select d.day,
      (select count(distinct vid) from page_views p where coalesce(p.site,'optiroas')='kiteo' and (p.at at time zone 'Asia/Dubai')::date=d.day and (p.vid is null or p.vid <> all(${tv})))::int as visitors,
      (select coalesce(sum(n),0) from page_views p where coalesce(p.site,'optiroas')='kiteo' and (p.at at time zone 'Asia/Dubai')::date=d.day and (p.vid is null or p.vid <> all(${tv})))::int as views,
      (select count(*) from users u where u.brand='kiteo' and (u.created_at at time zone 'Asia/Dubai')::date=d.day and lower(u.email) <> all(${ext}))::int as accounts,
      (select count(*) from ai_requests r where coalesce(r.service,'check')<>'commerce' and (r.created_at at time zone 'Asia/Dubai')::date=d.day and lower(r.email) <> all(${ext}))::int as checks,
      (select count(*) from ai_requests r where r.service='commerce' and (r.created_at at time zone 'Asia/Dubai')::date=d.day and lower(r.email) <> all(${ext}))::int as waitlist,
      (select count(*) from site_events e where coalesce(e.site,'optiroas')='kiteo' and e.ev='k_checkout' and (e.at at time zone 'Asia/Dubai')::date=d.day)::int as clicks,
      (select count(*) from site_events e where coalesce(e.site,'optiroas')='kiteo' and e.ev='k_subscribed' and (e.at at time zone 'Asia/Dubai')::date=d.day)::int as subs,
      (select coalesce(sum(val),0) from site_events e where coalesce(e.site,'optiroas')='kiteo' and e.ev='k_subscribed' and (e.at at time zone 'Asia/Dubai')::date=d.day)::numeric as revenue
    from d order by d.day desc`;

  const stats = { visitors: t1.visitors, newAccounts: newAcc.length, freeChecks: newChecks.length, waitlist: newWait.length, subscribeClicks: e1.clicks, newSubscriptions: e1.subs, revenue: n0(e1.revenue) };
  if (!(cron || /[?&]send=1/.test(req.url || ''))) return json(res, 200, { ok: true, stats });
  if (!mailOn()) return json(res, 200, { ok: true, skipped: 'email not configured' });

  // Excel
  const accRow = a => [a.name || '', a.email, a.company || a.tracked || '', a.website || '', uae(a.created_at), a.email_verified_at ? 'Yes' : 'No', a.tracked ? 'Yes' : 'No',
    a.plan === 'kiteo' ? 'Yes' : 'No', COUNTRY[a.country] || a.country || '', a.answers, a.utm_source || 'direct / unknown', a.lang === 'ar' ? 'Arabic' : 'English'];
  const reqRow = r => [uae(r.created_at), SERVICE[r.service || 'check'] || r.service || '', r.brand || '', r.website || '', COUNTRY[r.country] || r.country || '', r.name || '', r.email, r.phone || '', r.lang === 'ar' ? 'Arabic' : 'English', r.has_account ? 'Yes' : 'No'];
  const book = xlsx([
    { name: 'Summary', widths: [40, 16, 16], rows: [['', 'Last 24 hours', 'The 24 hours before'],
      ['Visitors', t1.visitors, t0.visitors], ['Page views', t1.views, t0.views], ['Visitors who saw Pricing', t1.pricing, t0.pricing],
      ['New accounts', newAcc.length, prevAcc.length], ['Free AI check and service requests', newChecks.length, prevReq.filter(r => !isWait(r)).length],
      ['Kiteo Commerce waitlist sign-ups', newWait.length, prevReq.filter(isWait).length], ['"Subscribe now" clicks', e1.clicks, e0.clicks],
      ['New subscriptions', e1.subs, e0.subs], ['Revenue (AED, after promo codes, before VAT)', Math.round(n0(e1.revenue)), Math.round(n0(e0.revenue))], ['Cancellations', e1.cancels, e0.cancels],
      ['', '', ''], ['Totals', '', ''], ['Kiteo accounts', accounts.length, ''], ['  email confirmed', accounts.filter(a => a.email_verified_at).length, ''],
      ['  brand set up', accounts.filter(a => a.tracked).length, ''], ['Active subscribers', subscribers, ''], ['All requests', requests.filter(r => !isWait(r)).length, ''],
      ['Kiteo Commerce waitlist', requests.filter(isWait).length, ''], ['', '', ''], ['Generated (UAE)', uae(new Date()), ''], ['Team and tester accounts are left out.', '', '']] },
    { name: '30-day trend', widths: [12, 10, 11, 10, 12, 10, 12, 12, 14], rows: [['Day (UAE)', 'Visitors', 'Page views', 'Accounts', 'Free checks', 'Waitlist', 'Subscribe clicks', 'Subscriptions', 'Revenue (AED)'],
      ...trend.map(t => [new Date(t.day).toISOString().slice(0, 10), t.visitors, t.views, t.accounts, t.checks, t.waitlist, t.clicks, t.subs, Math.round(n0(t.revenue))])] },
    { name: 'Traffic today', widths: [22, 10, 10, 16, 4, 26, 10, 10], rows: [['Page', 'Views', 'Visitors', 'Avg time per visitor', '', 'Source', 'Visitors', 'Views'],
      ...Array.from({ length: Math.max(pages.length, sources.length) }, (_, i) => { const p = pages[i], s = sources[i];
        return [p ? PAGE[p.page] || p.page : '', p ? p.views : '', p ? p.visitors : '', p ? mins(p.secs / Math.max(1, p.visitors)) : '', '', s ? s.src : '', s ? s.visitors : '', s ? s.views : '']; })] },
    { name: 'Accounts', widths: [22, 32, 22, 24, 17, 10, 10, 10, 14, 10, 18, 10], rows: [['Name', 'Email', 'Brand', 'Website', 'Signed up (UAE)', 'Email confirmed', 'Brand set up', 'Subscribed', 'Country', 'AI answers so far', 'Source', 'Language'], ...accounts.map(accRow)] },
    { name: 'Requests', widths: [17, 22, 22, 24, 14, 22, 32, 18, 10, 12], rows: [['Received (UAE)', 'Request', 'Brand', 'Website', 'Country', 'Name', 'Email', 'Phone / WhatsApp', 'Language', 'Has an account'], ...requests.map(reqRow)] },
    { name: 'Subscriptions', widths: [17, 14, 14, 22, 32, 30], rows: [['When (UAE)', 'Event', 'Paid (AED)', 'Name / brand', 'Email', 'Details'],
      ...subsList.map(s => [uae(s.at), s.val != null ? 'Subscribed' : 'Cancelled', s.val != null ? Math.round(n0(s.val)) : '', s.name || s.brand || '', s.email || '', s.detail || ''])] }
  ]);

  // Email
  const row = (k, a, b) => `<tr><td style="padding:5px 18px 5px 0;color:#4a5b8c">${k}</td><td style="padding:5px 0;text-align:right"><b>${a}</b>${b === undefined ? '' : delta(typeof a === 'string' ? n0(String(a).replace(/[^\d.-]/g, '')) : a, b)}</td></tr>`;
  const li = cells => `<li style="margin:0 0 6px">${cells.filter(Boolean).join(' · ')}</li>`;
  const h3 = t => `<h3 style="margin:22px 0 8px;font-size:15px;color:#0a1f5c">${t}</h3>`;
  const table = (head, rows) => rows.length ? `<table style="border-collapse:collapse;width:100%;font-size:13px"><tr>${head.map((h, i) => `<th style="text-align:${i ? 'right' : 'left'};padding:4px 8px 4px 0;color:#4a5b8c;border-bottom:1px solid #dce4ff;font-weight:600">${h}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map((c, i) => `<td style="text-align:${i ? 'right' : 'left'};padding:4px 8px 4px 0;border-bottom:1px solid #f1f4ff">${esc(c)}</td>`).join('')}</tr>`).join('')}</table>` : '<p style="color:#4a5b8c;margin:0">No visits recorded yet.</p>';
  const pct = (a, b) => b ? ` (${Math.round(100 * a / b)}%)` : '';
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0a1f5c;max-width:660px">
    <div style="background:#0a1f5c;color:#fff;padding:18px 22px;border-radius:14px 14px 0 0"><div style="font-size:20px;font-weight:bold">◆ Kiteo today</div>
      <div style="color:#c9d5ff;margin-top:4px">Last 24 hours to ${esc(uae(new Date()))} UAE time · arrows compare with the 24 hours before</div></div>
    <div style="border:1px solid #dce4ff;border-top:0;border-radius:0 0 14px 14px;padding:6px 22px 22px">
    ${h3('Headlines')}<table style="border-collapse:collapse">
      ${row('Visitors', t1.visitors, t0.visitors)}${row('Page views', t1.views, t0.views)}${row('New accounts', newAcc.length, prevAcc.length)}
      ${row('Free AI check and service requests', newChecks.length, prevReq.filter(r => !isWait(r)).length)}${row('Kiteo Commerce waitlist sign-ups', newWait.length, prevReq.filter(isWait).length)}
      ${row('"Subscribe now" clicks', e1.clicks, e0.clicks)}${row('New subscriptions', e1.subs, e0.subs)}${row('Revenue', aed(e1.revenue), n0(e0.revenue))}${row('Cancellations', e1.cancels, e0.cancels)}</table>
    ${h3('Funnel (last 24 hours)')}<p style="margin:0">${t1.visitors} visitors → ${t1.pricing} saw Pricing${pct(t1.pricing, t1.visitors)} → ${e1.clicks} clicked Subscribe → ${e1.subs} subscribed${pct(e1.subs, t1.visitors)}</p>
    ${h3('Totals')}<table style="border-collapse:collapse">${row('Kiteo accounts', accounts.length)}${row('Email confirmed', accounts.filter(a => a.email_verified_at).length)}${row('Brand set up', accounts.filter(a => a.tracked).length)}
      ${row('Active subscribers', subscribers)}${row('All free check / service requests', requests.filter(r => !isWait(r)).length)}${row('Kiteo Commerce waitlist', requests.filter(isWait).length)}</table>
    ${newChecks.length ? h3('New requests') + `<ul style="padding-left:18px;margin:0">${newChecks.map(r => li([`<b>${esc(SERVICE[r.service || 'check'] || r.service)}</b>`, esc(r.brand), r.website && esc(r.website), esc(COUNTRY[r.country] || r.country || ''), esc(r.name), `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>`, r.phone && esc(r.phone), r.lang === 'ar' ? 'Arabic' : 'English'])).join('')}</ul>` : ''}
    ${newWait.length ? h3('New waitlist sign-ups') + `<ul style="padding-left:18px;margin:0">${newWait.map(r => li([`<b>${esc(r.brand || '')}</b>`, `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>`, r.lang === 'ar' ? 'Arabic' : 'English'])).join('')}</ul>` : ''}
    ${newAcc.length ? h3('New accounts') + `<ul style="padding-left:18px;margin:0">${newAcc.map(a => li([`<b>${esc(a.name || a.email)}</b>`, `<a href="mailto:${esc(a.email)}">${esc(a.email)}</a>`, (a.company || a.tracked) && esc(a.company || a.tracked), a.website && esc(a.website), a.email_verified_at ? 'email confirmed' : 'email not confirmed yet', a.tracked ? 'brand set up' : 'brand not set up yet', a.utm_source && 'from ' + esc(a.utm_source)])).join('')}</ul>` : ''}
    ${e1.subs || e1.cancels ? h3('Subscriptions') + `<ul style="padding-left:18px;margin:0">${subsList.filter(s => Date.now() - new Date(s.at) < 24 * 3600e3).map(s => li([`<b>${s.val != null ? 'Subscribed' : 'Cancelled'}</b>`, s.val != null && aed(s.val), esc(s.name || s.brand || ''), s.email && esc(s.email), s.detail && esc(s.detail)])).join('')}</ul>` : ''}
    ${!newReq.length && !newAcc.length ? '<p style="margin-top:16px">No new registrations in the last 24 hours.</p>' : ''}
    ${h3('Traffic by page')}${table(['Page', 'Views', 'Visitors', 'Avg time'], pages.map(p => [PAGE[p.page] || p.page, p.views, p.visitors, mins(p.secs / Math.max(1, p.visitors))]))}
    ${h3('Where visitors came from')}${table(['Source', 'Visitors', 'Views'], sources.map(s => [s.src, s.visitors, s.views]))}
    ${h3('Product use (last 24 hours)')}<table style="border-collapse:collapse">${row('AI answers collected', usage.answers)}${row('Brands checked', usage.brands_checked)}${row('Brands newly set up', usage.brands_new)}${row('Website checks run', siteChecks)}${row('Alerts created', usage.alerts)}</table>
    <p style="margin-top:22px;color:#4a5b8c;font-size:12px">Team and tester accounts are left out. Revenue is what customers paid at checkout, after promo codes and before VAT; renewals aren't included.
      Traffic counts visitors who use the site with JavaScript on; ad blockers can hide some. The attached Excel has a 30-day trend and every account, request and subscription. Site: ${esc(KITEO_SITE())}</p></div></div>`;
  const text = `Kiteo today (last 24h)\nVisitors: ${t1.visitors} (${t1.views} page views)\nNew accounts: ${newAcc.length}\nFree check / service requests: ${newChecks.length}\nWaitlist sign-ups: ${newWait.length}\nSubscribe clicks: ${e1.clicks}\nNew subscriptions: ${e1.subs} (${aed(e1.revenue)})\nCancellations: ${e1.cancels}\nActive subscribers: ${subscribers}\n\n`
    + newReq.map(r => `Request: ${SERVICE[r.service || 'check'] || r.service} · ${r.brand || ''} · ${r.website || ''} · ${r.name || ''} · ${r.email} · ${r.phone || ''}`).join('\n')
    + '\n' + newAcc.map(a => `Account: ${a.name || ''} · ${a.email} · ${a.company || a.tracked || ''} · ${a.website || ''}`).join('\n');
  const reg = newAcc.length + newReq.length;
  const ok = await sendMail({ to: process.env.KITEO_REPORT_EMAIL || KITEO_SUPPORT(), brand: 'kiteo', text, html,
    subject: `Kiteo today: ${t1.visitors} visitor${t1.visitors === 1 ? '' : 's'}, ${reg} new registration${reg === 1 ? '' : 's'}, ${e1.subs} subscription${e1.subs === 1 ? '' : 's'}`,
    attachments: [{ filename: `Kiteo report ${new Date().toISOString().slice(0, 10)}.xlsx`, content: book.toString('base64') }] });
  return json(res, ok ? 200 : 502, { ok, stats });
}
