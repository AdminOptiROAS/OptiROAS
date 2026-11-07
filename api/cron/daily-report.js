import { ensureSchema, sql, json, currentUser } from '../_lib/core.js';
import { isAdmin } from '../_lib/plan.js';
import { sendMail, mailOn, SITE } from '../_lib/mail.js';

// Daily (vercel.json cron, 08:10 Dubai): emails the owner what happened in the last 24 hours.
// Team, reviewer and early-access emails are left out of the customer numbers.
const list = k => (process.env[k] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export default async function handler(req, res) {
  // The cron sends the email; a signed-in admin can open this URL to see today's numbers (add ?send=1 to email them too).
  const cron = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const me = cron ? null : await currentUser(req).catch(() => null);
  if (!cron && !(me && isAdmin(me))) return json(res, 401, { error: 'Unauthorized' });
  await ensureSchema();
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
    ${row('Audits run', `${audits.n} (by ${audits.people} ${audits.people === 1 ? 'person' : 'people'})`)}${row('AED 55 pop-up', `${ev.offer} seen, ${ev.offer_click} clicked`)}${row('Unlock offers seen', ev.paywall)}${row('Checkouts started', ev.checkout)}
    ${row('New subscriptions', subs24.n)}${row('Full reports unlocked', unlocks.n)}${row('Paying accounts now', paid)}
    ${row('Ad accounts connected (all users)', `Meta ${conns.meta} · Google ${conns.google} · Snapchat ${conns.snap} · TikTok ${conns.tiktok}`)}</table>
    ${pageTable}
    ${visitSrc.length ? `<p style="margin:8px 0 0;color:#5b667a">Visitors by source: ${visitSrc.map(v => `${esc(v.src)} ${v.visitors}`).join(' · ')}</p>` : ''}
    ${newList.length ? `<h3 style="margin:20px 0 6px">New sign-ups</h3><ul style="padding-left:18px;margin:0">${newList.map(u => `<li>${esc(u.email)}${u.name ? ' (' + esc(u.name) + ')' : ''}${u.utm_source ? ' · from ' + esc(u.utm_source) + (u.utm_campaign ? ' / ' + esc(u.utm_campaign) : '') : ''}${u.verified ? '' : ' · email not confirmed yet'}</li>`).join('')}</ul>` : ''}
    ${bySource.length ? `<h3 style="margin:20px 0 6px">Sign-ups by source, last 7 days</h3><ul style="padding-left:18px;margin:0">${bySource.map(s => `<li>${esc(s.src)}${s.camp ? ' / ' + esc(s.camp) : ''}: ${s.n}</li>`).join('')}</ul>` : ''}
    ${fb.length ? `<h3 style="margin:20px 0 6px">Feedback</h3><ul style="padding-left:18px;margin:0">${fb.map(f => `<li>${f.rating ? f.rating + '/5 · ' : ''}${esc(String(f.message || '').slice(0, 300))}${f.page ? ' <span style="color:#5b667a">(' + esc(f.page) + ')</span>' : ''}</li>`).join('')}</ul>` : ''}
    <p style="margin-top:20px;color:#5b667a">Countries and devices: Google Analytics → Reports. Payments: Stripe dashboard. Site: ${esc(SITE())}</p></div>`;
  const text = `OptiROAS daily summary (last 24h, customers only)\nVisitors: ${visits.visitors} (${visits.views} page views)\nNew sign-ups: ${users.new24}\nAudits run: ${audits.n}\nUnlock offers seen: ${ev.paywall}\nCheckouts started: ${ev.checkout}\nNew subscriptions: ${subs24.n}\nPaying accounts: ${paid}`;
  const stats = { visits, pages, visitSrc, users, bySource, newList, audits, unlocks, events: ev, plans, subs24, conns, feedback: fb.length };
  const wantMail = cron || /[?&]send=1/.test(req.url || '');
  if (!wantMail) return json(res, 200, { ok: true, stats });
  const to = process.env.REPORT_EMAIL || list('ADMIN_EMAILS')[0] || 'admin@optiroas.com';
  if (!mailOn()) return json(res, 200, { ok: true, skipped: 'email not configured' });
  const ok = await sendMail({ to, subject: `OptiROAS today: ${visits.visitors} visitor${visits.visitors === 1 ? '' : 's'}, ${users.new24} sign-up${users.new24 === 1 ? '' : 's'}, ${ev.checkout} checkout${ev.checkout === 1 ? '' : 's'}, ${subs24.n} new subscription${subs24.n === 1 ? '' : 's'}`, html, text });
  return json(res, ok ? 200 : 502, { ok, stats });
}
