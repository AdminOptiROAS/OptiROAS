import { ensureSchema, sql, json, currentUser } from '../_lib/core.js';
import { isAdmin } from '../_lib/plan.js';
import { sendMail, mailOn, SITE } from '../_lib/mail.js';
import { xlsx } from '../_lib/xlsx.js';

// Daily (vercel.json cron, 08:10 Dubai): emails the owner what happened in the last 24 hours.
// Team, reviewer and early-access emails are left out of the customer numbers.
const list = k => (process.env[k] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// The Excel file attached to the daily email: every customer and where they are (signed up → ran an audit → subscribed),
// plus the "email me the link" leads. Times in UAE time.
const PLAN = { audit: 'Audit (AED 55/month)', starter: 'Starter (AED 199/month)', pro: 'Pro (AED 499/month)' };
const uae = d => d ? new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Dubai' }).slice(0, 16) : '';
async function customerWorkbook(ext) {
  const us = await sql`select u.email, u.name, u.created_at, u.utm_source, u.utm_campaign, u.email_verified_at, u.plan, u.audit_credits, u.period_start, u.period_end,
      u.lang, u.nurture_step, u.mkt_unsub_at,
      (select count(*) from usage_reports r where r.user_id=u.id)::int as audits, (select max(at) from usage_reports r where r.user_id=u.id) as last_audit,
      (select count(*) from audit_unlocks a where a.user_id=u.id)::int as unlocked,
      concat_ws(', ', case when exists(select 1 from meta_connections c where c.user_id=u.id) then 'Meta' end,
        case when exists(select 1 from google_connections c where c.user_id=u.id) then 'Google' end,
        case when exists(select 1 from tiktok_connections c where c.user_id=u.id) then 'TikTok' end,
        case when exists(select 1 from snap_connections c where c.user_id=u.id) then 'Snapchat' end,
        case when exists(select 1 from salla_connections c where c.user_id=u.id) then 'Salla' end) as connected
    from users u where lower(u.email) <> all(${ext}) order by u.created_at desc limit 20000`;
  const subOf = u => PLAN[u.plan] || (u.audit_credits > 0 ? `Pay per audit (${u.audit_credits} left)` : '');
  const stage = u => subOf(u) ? '3. Subscribed' : u.audits > 0 ? '2. Ran an audit' : '1. Signed up';
  const rows = [['Email', 'Name', 'Stage', 'Signed up (UAE)', 'Email confirmed', 'Ran audit', 'Audits run', 'Last audit (UAE)', 'Full reports unlocked',
    'Subscribed', 'Subscription', 'Subscribed since (UAE)', 'Renews / ends (UAE)', 'Ad accounts connected', 'Source', 'Campaign', 'Language', 'Follow-up emails sent', 'Unsubscribed from emails']];
  for (const u of us) rows.push([u.email, u.name || '', stage(u), uae(u.created_at), u.email_verified_at ? 'Yes' : 'No', u.audits > 0 ? 'Yes' : 'No', u.audits, uae(u.last_audit), u.unlocked,
    subOf(u) ? 'Yes' : 'No', subOf(u) || '—', subOf(u) ? uae(u.period_start) : '', subOf(u) ? uae(u.period_end) : '', u.connected || '', u.utm_source || 'direct / unknown', u.utm_campaign || '',
    u.lang === 'ar' ? 'Arabic' : u.lang === 'en' ? 'English' : '', u.nurture_step || 0, u.mkt_unsub_at ? 'Yes' : 'No']);
  const ls = await sql`select l.email, l.lang, l.source, l.campaign, l.created_at, l.sends, l.unsubscribed_at, exists(select 1 from users u where lower(u.email)=l.email) as signed
    from leads l where l.email <> all(${ext}) order by l.created_at desc limit 20000`;
  const lrows = [['Email', 'Asked on (UAE)', 'Signed up', 'Source', 'Campaign', 'Language', 'Emails sent', 'Unsubscribed']];
  for (const l of ls) lrows.push([l.email, uae(l.created_at), l.signed ? 'Yes' : 'No', l.source || 'direct / unknown', l.campaign || '', l.lang === 'ar' ? 'Arabic' : 'English', l.sends, l.unsubscribed_at ? 'Yes' : 'No']);
  const n = f => us.filter(f).length;
  const summary = [['Stage', 'People'], ['Signed up (all)', us.length], ['Confirmed their email', n(u => u.email_verified_at)], ['Ran at least one audit', n(u => u.audits > 0)],
    ['Subscribed (any plan)', n(u => subOf(u))], ...Object.keys(PLAN).map(k => ['  ' + PLAN[k], n(u => u.plan === k)]), ['  Pay per audit', n(u => !PLAN[u.plan] && u.audit_credits > 0)],
    ['Signed up, no audit yet', n(u => !u.audits && !subOf(u))], ['Ran an audit, not subscribed', n(u => u.audits > 0 && !subOf(u))],
    ['Email-link leads', ls.length], ['  of whom signed up', ls.filter(l => l.signed).length], ['', ''], ['Generated (UAE)', uae(new Date())], ['Team, reviewer and test accounts are left out.', '']];
  return xlsx([{ name: 'Summary', rows: summary, widths: [40, 22] },
    { name: 'Customers', rows, widths: [32, 18, 16, 17, 10, 10, 10, 17, 10, 11, 26, 17, 17, 22, 18, 18, 10, 10, 12] },
    { name: 'Email-link leads', rows: lrows, widths: [32, 17, 10, 18, 18, 10, 10, 12] }]);
}

export default async function handler(req, res) {
  // The cron sends the email; a signed-in admin can open this URL to see today's numbers (add ?send=1 to email them too).
  const cron = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const me = cron ? null : await currentUser(req).catch(() => null);
  if (!cron && !(me && isAdmin(me))) return json(res, 401, { error: 'Unauthorized' });
  await ensureSchema();
  const internal0 = [...new Set([...list('ADMIN_EMAILS'), ...list('REVIEW_EMAILS'), ...list('ALLOWED_EMAILS')])];
  if (!cron && /[?&]xlsx=1/.test(req.url || '')) {
    const buf = await customerWorkbook(internal0.length ? internal0 : ['-']);
    res.statusCode = 200; res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="OptiROAS customers ${new Date().toISOString().slice(0, 10)}.xlsx"`); res.setHeader('Cache-Control', 'no-store');
    return res.end(buf);
  }
  const internal = [...new Set([...list('ADMIN_EMAILS'), ...list('REVIEW_EMAILS'), ...list('ALLOWED_EMAILS')])];
  const ext = internal.length ? internal : ['-'];
  const one = async q => (await q)[0];
  const users = await one(sql`select count(*)::int as total,
      count(*) filter (where created_at > now() - interval '24 hours')::int as new24,
      count(*) filter (where created_at > now() - interval '7 days')::int as new7
    from users where lower(email) <> all(${ext})`);
  const bySource = await sql`select coalesce(utm_source,'direct / unknown') as src, coalesce(utm_campaign,'') as camp, count(*)::int as n from users
    where created_at > now() - interval '7 days' and lower(email) <> all(${ext}) group by 1,2 order by n desc limit 15`;
  const newList = await sql`select email, name, created_at, utm_source, utm_campaign, email_verified_at is not null as verified from users
    where created_at > now() - interval '24 hours' and lower(email) <> all(${ext}) order by created_at desc limit 25`;
  const audits = await one(sql`select count(*)::int as n, count(distinct r.user_id)::int as people from usage_reports r join users u on u.id=r.user_id
    where r.at > now() - interval '24 hours' and lower(u.email) <> all(${ext})`);
  const unlocks = await one(sql`select count(*)::int as n from audit_unlocks a join users u on u.id=a.user_id
    where a.at > now() - interval '24 hours' and lower(u.email) <> all(${ext})`);
  const ev = await one(sql`select count(*) filter (where ev='checkout_start')::int as checkout, count(*) filter (where ev='paywall_open')::int as paywall,
      count(*) filter (where ev='offer_open')::int as offer, count(*) filter (where ev='offer_click')::int as offer_click
    from site_events where at > now() - interval '24 hours'`);
  const leads = await one(sql`select count(*) filter (where created_at > now() - interval '24 hours')::int as new24, count(*)::int as total from leads where email <> all(${ext})`);
  const plans = await sql`select plan, count(*)::int as n from users where plan <> 'free' and lower(email) <> all(${ext}) group by plan order by plan`;
  const subs24 = await one(sql`select count(*)::int as n from users where plan <> 'free' and period_start > now() - interval '24 hours' and lower(email) <> all(${ext})`);
  const conns = await one(sql`select (select count(*) from meta_connections)::int as meta, (select count(*) from google_connections)::int as google,
    (select count(*) from snap_connections)::int as snap, (select count(*) from tiktok_connections)::int as tiktok`);
  // Visits recorded by the site itself; browsers that ever signed in with a team account are left out
  const tv = (await sql`select distinct pv.vid from page_views pv join users u on u.id=pv.user_id where pv.vid is not null and lower(u.email) = any(${ext})`).map(r => r.vid);
  const teamVid = tv.length ? tv : ['-'];
  const visits = await one(sql`select count(distinct vid)::int as visitors, coalesce(sum(n),0)::int as views, coalesce(sum(secs),0)::int as secs
    from page_views where at > now() - interval '24 hours' and (vid is null or vid <> all(${teamVid}))`);
  const pages = await sql`select page, sum(n)::int as views, count(distinct vid)::int as visitors, sum(secs)::int as secs
    from page_views where at > now() - interval '24 hours' and (vid is null or vid <> all(${teamVid}))
    group by page having sum(n) > 0 order by views desc limit 15`;
  const visitSrc = await sql`select coalesce(nullif(src,''),'direct / unknown') as src, count(distinct vid)::int as visitors
    from page_views where at > now() - interval '24 hours' and (vid is null or vid <> all(${teamVid})) group by 1 order by 2 desc limit 10`;
  const fb = await sql`select rating, message, page, created_at from feedback where created_at > now() - interval '24 hours' order by created_at desc limit 10`;

  const dur = t => { t = Math.round(t || 0); return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`; };
  const NAMES = { home: 'Home', workspace: 'Home (signed in)', start: 'Guided upload', audit: 'Report', how: 'How it works', pricing: 'Pricing', faq: 'FAQ',
    platforms: 'Platforms', delivered: 'Delivered ROAS', pillars: 'The 12 pillars', calculator: 'Calculator page', welcome: 'Welcome (after paying)',
    signin: 'Sign in / sign up', account: 'My account', privacy: 'Privacy', terms: 'Terms', 'data-deletion': 'Data deletion' };
  const td = (v, r) => `<td style="padding:5px 14px 5px 0;${r ? 'text-align:right;' : ''}border-bottom:1px solid #e6eaf0">${v}</td>`;
  const pageTable = pages.length ? `<h3 style="margin:20px 0 6px">What visitors looked at</h3><table style="border-collapse:collapse">
    <tr style="color:#5b667a">${td('Page')}${td('Views', 1)}${td('Visitors', 1)}${td('Avg time on page', 1)}</tr>
    ${pages.map(r => `<tr>${td(esc(NAMES[r.page] || r.page))}${td(r.views, 1)}${td(r.visitors, 1)}${td(dur(r.secs / Math.max(1, r.views)), 1)}</tr>`).join('')}</table>` : '';
  const row = (k, v) => `<tr><td style="padding:6px 12px 6px 0;color:#5b667a">${k}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`;
  const paid = plans.map(p => `${esc(p.plan)}: ${p.n}`).join(' · ') || 'none';
  const html = `<div style="font:14px/1.5 Arial,sans-serif;color:#0f1a2b;max-width:620px">
    <h2 style="margin:0 0 4px">OptiROAS daily summary</h2><p style="margin:0 0 16px;color:#5b667a">Last 24 hours, customers only (team and reviewer accounts excluded).</p>
    <table style="border-collapse:collapse">${row('Visitors', `${visits.visitors} (${visits.views} page views, ${dur(visits.secs / Math.max(1, visits.visitors))} on the site each on average)`)}${row('New sign-ups', users.new24)}${row('Sign-ups, last 7 days', users.new7)}${row('Customer accounts in total', users.total)}
    ${row('Asked to email the audit link', `${leads.new24} (${leads.total} in total)`)}${row('Audits run', `${audits.n} (by ${audits.people} ${audits.people === 1 ? 'person' : 'people'})`)}${row('AED 55 pop-up', `${ev.offer} seen, ${ev.offer_click} clicked`)}${row('Unlock offers seen', ev.paywall)}${row('Checkouts started', ev.checkout)}
    ${row('New subscriptions', subs24.n)}${row('Full reports unlocked', unlocks.n)}${row('Paying accounts now', paid)}
    ${row('Ad accounts connected (all users)', `Meta ${conns.meta} · Google ${conns.google} · Snapchat ${conns.snap} · TikTok ${conns.tiktok}`)}</table>
    ${pageTable}
    ${visitSrc.length ? `<p style="margin:8px 0 0;color:#5b667a">Visitors by source: ${visitSrc.map(v => `${esc(v.src)} ${v.visitors}`).join(' · ')}</p>` : ''}
    ${newList.length ? `<h3 style="margin:20px 0 6px">New sign-ups</h3><ul style="padding-left:18px;margin:0">${newList.map(u => `<li>${esc(u.email)}${u.name ? ' (' + esc(u.name) + ')' : ''}${u.utm_source ? ' · from ' + esc(u.utm_source) + (u.utm_campaign ? ' / ' + esc(u.utm_campaign) : '') : ''}${u.verified ? '' : ' · email not confirmed yet'}</li>`).join('')}</ul>` : ''}
    ${bySource.length ? `<h3 style="margin:20px 0 6px">Sign-ups by source, last 7 days</h3><ul style="padding-left:18px;margin:0">${bySource.map(s => `<li>${esc(s.src)}${s.camp ? ' / ' + esc(s.camp) : ''}: ${s.n}</li>`).join('')}</ul>` : ''}
    ${fb.length ? `<h3 style="margin:20px 0 6px">Feedback</h3><ul style="padding-left:18px;margin:0">${fb.map(f => `<li>${f.rating ? f.rating + '/5 · ' : ''}${esc(String(f.message || '').slice(0, 300))}${f.page ? ' <span style="color:#5b667a">(' + esc(f.page) + ')</span>' : ''}</li>`).join('')}</ul>` : ''}
    <p style="margin-top:20px;color:#5b667a">The attached Excel file lists every customer with their stage (signed up, ran an audit, subscribed) and plan, plus the email-link leads.</p>
    <p style="margin-top:20px;color:#5b667a">Countries and devices: Google Analytics → Reports. Payments: Stripe dashboard. Site: ${esc(SITE())}</p></div>`;
  const text = `OptiROAS daily summary (last 24h, customers only)\nVisitors: ${visits.visitors} (${visits.views} page views)\nNew sign-ups: ${users.new24}\nAudits run: ${audits.n}\nUnlock offers seen: ${ev.paywall}\nCheckouts started: ${ev.checkout}\nNew subscriptions: ${subs24.n}\nPaying accounts: ${paid}`;
  const stats = { leads, visits, pages, visitSrc, users, bySource, newList, audits, unlocks, events: ev, plans, subs24, conns, feedback: fb.length };
  const wantMail = cron || /[?&]send=1/.test(req.url || '');
  if (!wantMail) return json(res, 200, { ok: true, stats });
  const to = process.env.REPORT_EMAIL || list('ADMIN_EMAILS')[0] || 'admin@optiroas.com';
  if (!mailOn()) return json(res, 200, { ok: true, skipped: 'email not configured' });
  let attachments = [];
  try { attachments = [{ filename: `OptiROAS customers ${new Date().toISOString().slice(0, 10)}.xlsx`, content: (await customerWorkbook(ext)).toString('base64') }]; }
  catch (e) { console.error('daily xlsx', e.message); }
  const ok = await sendMail({ to, attachments, subject: `OptiROAS today: ${visits.visitors} visitor${visits.visitors === 1 ? '' : 's'}, ${users.new24} sign-up${users.new24 === 1 ? '' : 's'}, ${ev.checkout} checkout${ev.checkout === 1 ? '' : 's'}, ${subs24.n} new subscription${subs24.n === 1 ? '' : 's'}`, html, text });
  return json(res, ok ? 200 : 502, { ok, stats });
}
