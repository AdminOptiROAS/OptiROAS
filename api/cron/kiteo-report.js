import { ensureSchema, sql, json, currentUser } from '../_lib/core.js';
import { isAdmin } from '../_lib/plan.js';
import { sendMail, mailOn, KITEO_SUPPORT, KITEO_SITE } from '../_lib/mail.js';
import { xlsx } from '../_lib/xlsx.js';

// Daily Kiteo summary (vercel.json cron, 08:15 Dubai) to admin@kiteoai.com: everyone who registered interest in the last 24 hours,
// with an Excel file of every Kiteo account and every request ever received.
// Where the details live: Kiteo accounts → users (brand='kiteo'); free-check, service and waitlist requests → ai_requests.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uae = d => d ? new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Dubai' }).slice(0, 16) : '';
const SERVICE = { check: 'Free AI check', reviews: 'Reviews programme', content: 'Content package', listings: 'Listings and placements', commerce: 'Kiteo Commerce waitlist' };
const COUNTRY = { SA: 'Saudi Arabia', AE: 'UAE', KW: 'Kuwait', QA: 'Qatar', BH: 'Bahrain', OM: 'Oman', EG: 'Egypt' };

export default async function handler(req, res) {
  const cron = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const me = cron ? null : await currentUser(req).catch(() => null);
  if (!cron && !(me && isAdmin(me))) return json(res, 401, { error: 'Unauthorized' });
  await ensureSchema();
  await sql`create table if not exists ai_requests(id bigserial primary key, email text not null, name text, phone text, brand text, website text, country text, lang text, user_id uuid, created_at timestamptz not null default now())`;
  await sql`alter table ai_requests add column if not exists service text`;

  const accounts = await sql`select u.id, u.email, u.name, u.company, u.website, u.lang, u.created_at, u.email_verified_at,
      b.brand as tracked, b.country, (select count(*) from ai_jobs j where j.user_id=u.id and j.status='done')::int as answers
    from users u left join ai_brands b on b.user_id=u.id where u.brand='kiteo' order by u.created_at desc limit 20000`;
  const requests = await sql`select r.*, exists(select 1 from users u where u.brand='kiteo' and lower(u.email)=lower(r.email)) as has_account
    from ai_requests r order by r.created_at desc limit 20000`;
  const day = x => Date.now() - new Date(x.created_at) < 24 * 3600e3;
  const newAcc = accounts.filter(day), newReq = requests.filter(day);

  const accRow = a => [a.name || '', a.email, a.company || a.tracked || '', a.website || '', uae(a.created_at), a.email_verified_at ? 'Yes' : 'No', a.tracked ? 'Yes' : 'No', COUNTRY[a.country] || a.country || '', a.answers, a.lang === 'ar' ? 'Arabic' : 'English'];
  const reqRow = r => [uae(r.created_at), SERVICE[r.service || 'check'] || r.service || '', r.brand || '', r.website || '', COUNTRY[r.country] || r.country || '', r.name || '', r.email, r.phone || '', r.lang === 'ar' ? 'Arabic' : 'English', r.has_account ? 'Yes' : 'No'];
  const book = xlsx([
    { name: 'Summary', widths: [36, 14], rows: [['Kiteo accounts', accounts.length], ['  new in the last 24 hours', newAcc.length], ['  brand set up', accounts.filter(a => a.tracked).length],
      ['Requests (free checks, services, waitlist)', requests.length], ['  new in the last 24 hours', newReq.length], ['', ''], ['Generated (UAE)', uae(new Date())]] },
    { name: 'Accounts', widths: [22, 32, 22, 24, 17, 10, 10, 14, 10, 10], rows: [['Name', 'Email', 'Brand', 'Website', 'Signed up (UAE)', 'Email confirmed', 'Brand set up', 'Country', 'AI answers so far', 'Language'], ...accounts.map(accRow)] },
    { name: 'Requests', widths: [17, 22, 22, 24, 14, 22, 32, 18, 10, 12], rows: [['Received (UAE)', 'Request', 'Brand', 'Website', 'Country', 'Name', 'Email', 'Phone / WhatsApp', 'Language', 'Has an account'], ...requests.map(reqRow)] }
  ]);

  const stats = { accounts: accounts.length, newAccounts: newAcc.length, requests: requests.length, newRequests: newReq.length };
  if (!(cron || /[?&]send=1/.test(req.url || ''))) return json(res, 200, { ok: true, stats });
  if (!mailOn()) return json(res, 200, { ok: true, skipped: 'email not configured' });

  const li = (cells) => `<li style="margin:0 0 6px">${cells.filter(Boolean).join(' · ')}</li>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d1640;max-width:640px">
    <h2 style="margin:0 0 4px;color:#5b3fd1">◆ Kiteo today</h2><p style="margin:0 0 16px;color:#6b6585">Last 24 hours, ${esc(uae(new Date()))} UAE time</p>
    <table style="border-collapse:collapse;margin-bottom:16px">${[['New accounts', newAcc.length], ['New requests', newReq.length], ['All Kiteo accounts', accounts.length], ['All requests', requests.length]]
      .map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#6b6585">${k}</td><td style="padding:4px 0"><b>${v}</b></td></tr>`).join('')}</table>
    ${newReq.length ? `<h3 style="margin:16px 0 6px">New requests</h3><ul style="padding-left:18px;margin:0">${newReq.map(r => li([`<b>${esc(SERVICE[r.service || 'check'] || r.service)}</b>`, esc(r.brand), r.website && esc(r.website), esc(COUNTRY[r.country] || r.country || ''), esc(r.name), `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>`, r.phone && esc(r.phone), r.lang === 'ar' ? 'Arabic' : 'English'])).join('')}</ul>` : ''}
    ${newAcc.length ? `<h3 style="margin:16px 0 6px">New accounts</h3><ul style="padding-left:18px;margin:0">${newAcc.map(a => li([`<b>${esc(a.name || a.email)}</b>`, `<a href="mailto:${esc(a.email)}">${esc(a.email)}</a>`, (a.company || a.tracked) && esc(a.company || a.tracked), a.website && esc(a.website), a.email_verified_at ? 'email confirmed' : 'email not confirmed yet', a.tracked ? 'brand set up' : 'brand not set up yet'])).join('')}</ul>` : ''}
    ${!newReq.length && !newAcc.length ? '<p>No new registrations in the last 24 hours.</p>' : ''}
    <p style="margin-top:20px;color:#6b6585">The attached Excel file lists every Kiteo account and every request received so far. Site: ${esc(KITEO_SITE())}</p></div>`;
  const text = `Kiteo today (last 24h)\nNew accounts: ${newAcc.length}\nNew requests: ${newReq.length}\nAll accounts: ${accounts.length}\nAll requests: ${requests.length}\n\n`
    + newReq.map(r => `Request: ${SERVICE[r.service || 'check'] || r.service} · ${r.brand || ''} · ${r.website || ''} · ${r.name || ''} · ${r.email} · ${r.phone || ''}`).join('\n')
    + '\n' + newAcc.map(a => `Account: ${a.name || ''} · ${a.email} · ${a.company || a.tracked || ''} · ${a.website || ''}`).join('\n');
  const ok = await sendMail({ to: process.env.KITEO_REPORT_EMAIL || KITEO_SUPPORT(), brand: 'kiteo', text, html,
    subject: `Kiteo today: ${newAcc.length} new account${newAcc.length === 1 ? '' : 's'}, ${newReq.length} new request${newReq.length === 1 ? '' : 's'}`,
    attachments: [{ filename: `Kiteo registrations ${new Date().toISOString().slice(0, 10)}.xlsx`, content: book.toString('base64') }] });
  return json(res, ok ? 200 : 502, { ok, stats });
}
