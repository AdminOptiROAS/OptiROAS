import crypto from 'node:crypto';
import { ensureSchema, sql, json, body, currentUser, emailOk } from './_lib/core.js';
import { sendMail, mailOn, layout, SITE } from './_lib/mail.js';
import { isAdmin } from './_lib/plan.js';
import { unsubSig } from './_lib/nurture.js';

// "Email me the link": a visitor (usually on a phone) gets the link to run their audit on a computer.
//   POST /api/leads            {email, lang, src, camp, vid, page}  → stores the lead and sends the email
//   GET  /api/leads?u=<token>  → one-click unsubscribe
//   GET  /api/leads?export=1   → team only: all leads as a CSV (for follow-up and ad audiences)
const page = (lang, title, msg) => `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OptiROAS</title></head>
<body style="font-family:Segoe UI,Arial,sans-serif;background:#f4f7f9;color:#0f1f2b;margin:0;padding:48px 16px;text-align:center"><div style="max-width:440px;margin:auto;background:#fff;border-radius:12px;padding:32px">
<div style="font-size:22px;font-weight:800">Opti<span style="color:#0a6c86">ROAS</span></div><h1 style="font-size:20px">${title}</h1><p style="color:#3d4f5c">${msg}</p>
<p><a href="/" style="color:#0a6c86">optiroas.com</a></p></div></body></html>`;

export default async function handler(req, res) {
  await ensureSchema();
  const q = Object.fromEntries(new URL(req.url, 'https://x').searchParams);

  if (req.method === 'GET' && q.uu) {
    const [id, sig] = String(q.uu).split('.');
    const ok = id && sig && /^[0-9a-f-]{36}$/i.test(id) && sig === unsubSig(id);
    const r = ok ? await sql`update users set mkt_unsub_at=coalesce(mkt_unsub_at, now()) where id=${id} returning lang` : [];
    const ar = r[0] && r[0].lang === 'ar';
    res.statusCode = r[0] ? 200 : 404; res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(r[0] ? page(ar ? 'ar' : 'en', ar ? 'تم إلغاء الاشتراك' : 'You’re unsubscribed', ar ? 'لن نرسل لك رسائل تذكير أو تسويق بعد الآن. ستبقى رسائل حسابك المهمة مثل إعادة تعيين كلمة المرور والإيصالات.' : 'We won’t send you reminders or marketing emails again. You’ll still get essential account emails such as password resets and receipts.')
      : page('en', 'Link not found', 'This unsubscribe link isn’t valid. Email admin@optiroas.com and we’ll remove you.'));
  }
  if (req.method === 'GET' && q.u) {
    const r = await sql`update leads set unsubscribed_at=coalesce(unsubscribed_at, now()) where unsub_token=${String(q.u).slice(0, 80)} returning lang`;
    const ar = r[0] && r[0].lang === 'ar';
    res.statusCode = r[0] ? 200 : 404; res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(r[0] ? page(ar ? 'ar' : 'en', ar ? 'تم إلغاء الاشتراك' : 'You’re unsubscribed', ar ? 'لن نرسل لك رسائل أخرى ولن نستخدم بريدك في الإعلانات.' : 'We won’t email you again or use your email for ads.')
      : page('en', 'Link not found', 'This unsubscribe link isn’t valid. Email admin@optiroas.com and we’ll remove you.'));
  }

  if (req.method === 'GET' && q.export) {
    const user = await currentUser(req).catch(() => null);
    if (!user || !isAdmin(user)) return json(res, 403, { error: 'Team accounts only.' });
    const rows = await sql`select l.*, u.created_at as signed_up_at from leads l left join users u on lower(u.email)=l.email order by l.created_at desc limit 50000`;
    const cell = v => { const s = v == null ? '' : String(v instanceof Date ? v.toISOString() : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = '﻿' + [['Email', 'Language', 'Source', 'Campaign', 'Asked on (UTC)', 'Emails sent', 'Signed up (UTC)', 'Unsubscribed (UTC)'].join(',')]
      .concat(rows.map(r => [r.email, r.lang, r.source, r.campaign, r.created_at, r.sends, r.signed_up_at, r.unsubscribed_at].map(cell).join(','))).join('\n');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="optiroas-email-link-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.end(csv);
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const b = body(req);
  if (String(b.website || '')) return json(res, 200, { ok: true }); // honeypot
  const email = String(b.email || '').trim().toLowerCase();
  const lang = b.lang === 'ar' ? 'ar' : 'en', ar = lang === 'ar';
  if (!emailOk(email)) return json(res, 400, { error: ar ? 'أدخل بريدًا إلكترونيًا صحيحًا.' : 'Enter a valid email address.' });
  const busy = (await sql`select count(*)::int as n from leads where last_sent_at > now() - interval '1 minute'`)[0].n;
  if (busy > 20) return json(res, 429, { error: ar ? 'طلبات كثيرة الآن. حاول بعد دقيقة.' : 'Too many requests right now. Please try again in a minute.' });
  const cut = (v, n) => String(v || '').slice(0, n) || null;
  const row = (await sql`insert into leads(email, lang, source, campaign, vid, page, unsub_token)
      values(${email}, ${lang}, ${cut(b.src, 120)}, ${cut(b.camp, 120)}, ${cut(b.vid, 40)}, ${cut(b.page, 40)}, ${crypto.randomBytes(18).toString('base64url')})
      on conflict(email) do update set lang=excluded.lang, unsubscribed_at=null,
        source=coalesce(leads.source, excluded.source), campaign=coalesce(leads.campaign, excluded.campaign), vid=coalesce(excluded.vid, leads.vid)
      returning unsub_token, last_sent_at`)[0];
  // the same address asking again within 10 minutes: don't send a second copy
  if (row.last_sent_at && Date.now() - new Date(row.last_sent_at) < 10 * 60e3) return json(res, 200, { ok: true, again: true });
  if (!mailOn()) return json(res, 503, { error: ar ? 'تعذّر إرسال البريد الآن. حاول لاحقًا.' : 'We couldn’t send the email right now. Please try again later.' });
  const link = `${SITE()}/?lang=${lang}&utm_source=email&utm_medium=email&utm_campaign=desktop_link#audit`;
  const unsub = `${SITE()}/api/leads?u=${row.unsub_token}`;
  const m = layout({
    lang,
    title: ar ? 'رابط تدقيق إعلاناتك على OptiROAS' : 'Your OptiROAS audit link',
    intro: ar
      ? 'افتح هذا الرابط على الكمبيوتر الذي تدير منه إعلاناتك. ارفع ملفات حملاتك من Meta أو Google Ads أو TikTok أو Snapchat، والموقع يوضّح لك خطوة بخطوة كيف تنزّلها. ستحصل على درجة حسابك وأهم 3 إصلاحات مجانًا.'
      : 'Open this on the computer where you manage your ads. Upload your campaign exports from Meta, Google Ads, TikTok or Snapchat; the site shows you step by step how to download them. You’ll see your account score and top 3 fixes free.',
    button: ar ? 'شغّل تدقيقي' : 'Run my audit',
    link,
    outro: ar
      ? `طلبت هذا الرابط على optiroas.com. قد نرسل لك أحيانًا نصائح لتحسين إنفاقك الإعلاني. لإلغاء الاشتراك: ${unsub}`
      : `You asked for this link on optiroas.com. We may send you occasional tips on getting more from your ad spend. Unsubscribe: ${unsub}`
  });
  const ok = await sendMail({ to: email, subject: ar ? 'رابط تدقيق إعلاناتك' : 'Your link to run your ad audit', ...m });
  if (!ok) return json(res, 502, { error: ar ? 'تعذّر إرسال البريد. تحقّق من العنوان وحاول مرة أخرى.' : 'We couldn’t send the email. Check the address and try again.' });
  await sql`update leads set sends=sends+1, last_sent_at=now() where email=${email}`;
  return json(res, 200, { ok: true });
}
