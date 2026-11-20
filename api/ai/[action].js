import { ensureSchema, currentUser, sql, json, body, emailOk } from '../_lib/core.js';
import { sendMail, layout, mailOn } from '../_lib/mail.js';
import { ensureAi, aiAllowed, aiTeam as team, enqueue, work, summary, enginesOn, ENGINES, COUNTRIES, RUNS } from '../_lib/ai.js';
import { demand } from '../_lib/ai-demand.js';
import { parseGa4 } from '../_lib/ai-visits.js';
import { pullGa4, gaEmail, cleanProperty } from '../_lib/ga4.js';
import { alertsFor, listAlerts, googleReviews, reviewsState, placementsState, addPlacement, emailAlerts, emailMonthly } from '../_lib/ai-extra.js';

// Pull the last 28 days from the linked GA4 property and store it like an upload. Errors are kept on the brand.
async function syncGa(userId, property) {
  try {
    const d = await pullGa4(property);
    await sql`insert into ai_visits(user_id, start_date, end_date, file, data) values(${userId}, ${d.start}, ${d.end}, 'Google Analytics (connected)', ${JSON.stringify(d)})`;
    await sql`delete from ai_visits where user_id=${userId} and id not in (select id from ai_visits where user_id=${userId} order by uploaded_at desc limit 12)`;
    await sql`update ai_brands set ga_property=${cleanProperty(property)}, ga_synced_at=now(), ga_error=null where user_id=${userId}`;
    return null;
  } catch (e) {
    await sql`update ai_brands set ga_error=${String(e.message).slice(0, 300)}, ga_synced_at=now() where user_id=${userId} and ga_property is not null`;
    return e;
  }
}

// /api/ai/state | setup | run | tick | demand | visits | cron   (one function for the AI visibility section)
const clean = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const isAr = s => /[؀-ۿ]/.test(s);

async function state(u) {
  let s = await summary(u.id);
  if (s && s.batch && !s.progress) { try { await alertsFor(u.id, s); } catch (e) { console.error('ai alerts', e.message); } }
  const kw = (await sql`select country, data, error, fetched_at from ai_kw where user_id=${u.id}`)[0] || null;
  const visits = await sql`select id, start_date, end_date, file, data, uploaded_at from ai_visits where user_id=${u.id} order by uploaded_at desc limit 6`;
  const prompts = await sql`select id, text, lang from ai_prompts where user_id=${u.id} order by id`;
  return { allowed: true, team: team(u), engines: enginesOn().map(k => ({ key: k, name: ENGINES[k].name })), allEngines: Object.keys(ENGINES).map(k => ({ key: k, name: ENGINES[k].name })),
    runs: RUNS(), countries: Object.entries(COUNTRIES).map(([k, v]) => ({ code: k, en: v.en, ar: v.ar })), prompts, report: s, keywords: kw, visits,
    kpReady: !!(process.env.GOOGLE_KP_EMAIL && process.env.GOOGLE_KP_CUSTOMER_ID), gaEmail: gaEmail(),
    alerts: await listAlerts(u.id), reviews: await reviewsState(u.id), placements: await placementsState(u.id, s) };
}

export default async function handler(req, res) {
  const action = String((req.query && req.query.action) || new URL(req.url, 'https://x').pathname.split('/').pop());
  await ensureSchema(); await ensureAi();

  if (action === 'cron') {
    if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return json(res, 401, { error: 'Unauthorized' });
    let started = 0;
    if (enginesOn().length) {
      const due = await sql`select b.user_id from ai_brands b join users u on u.id=b.user_id where b.active and (b.last_batch_at is null or b.last_batch_at < now() - interval '7 days') limit 50`;
      for (const d of due) { const r = await enqueue(d.user_id); if (r.queued) started++; }
    }
    // weekly Google Analytics refresh for linked properties
    if (gaEmail()) for (const g of await sql`select user_id, ga_property from ai_brands where active and ga_property is not null and (ga_synced_at is null or ga_synced_at < now() - interval '6 days') limit 30`) await syncGa(g.user_id, g.ga_property);
    const done = await work({ ms: 220000, parallel: 8 });
    let mailed = 0, monthly = 0;
    for (const b of await sql`select user_id from ai_brands where active and last_batch_at is not null and (alerts_batch is null or alerts_batch < last_batch_at) limit 40`) {
      try { await alertsFor(b.user_id); if (await emailAlerts(b.user_id)) mailed++; } catch (e) { console.error('ai alerts cron', e.message); }
    }
    for (const b of await sql`select b.user_id from ai_brands b where b.active and b.alerts_batch is not null and b.created_at < now() - interval '7 days' and (b.monthly_sent_at is null or b.monthly_sent_at < now() - interval '30 days') limit 20`) {
      try { if (await emailMonthly(b.user_id)) monthly++; } catch (e) { console.error('ai monthly', e.message); }
    }
    if (process.env.GOOGLE_PLACES_API_KEY) for (const b of await sql`select user_id from ai_brands where active and (places_at is null or places_at < now() - interval '7 days') limit 20`) { try { await googleReviews(b.user_id); } catch (e) { console.error('ai places', e.message); } }
    return json(res, 200, { ok: true, started, done, mailed, monthly });
  }

  // "Book a free AI visibility check": open to anyone, emails the team and confirms to the visitor
  if (action === 'request' && req.method === 'POST') {
    const b = body(req), ar = b.lang === 'ar';
    if (String(b.website2 || '')) return json(res, 200, { ok: true }); // honeypot
    const service = ['reviews', 'content', 'listings'].includes(b.service) ? b.service : 'check';
    const email = String(b.email || '').trim().toLowerCase(), f = { name: clean(b.name, 80), phone: clean(b.phone, 30), brand: clean(b.brand, 80), website: clean(b.website, 120), country: COUNTRIES[b.country] ? b.country : 'SA' };
    if (!emailOk(email)) return json(res, 400, { error: ar ? 'أدخل بريدًا إلكترونيًا صحيحًا.' : 'Enter a valid email address.' });
    if (!f.brand) return json(res, 400, { error: ar ? 'أدخل اسم علامتك التجارية.' : 'Enter your brand name.' });
    await sql`create table if not exists ai_requests(id bigserial primary key, email text not null, name text, phone text, brand text, website text, country text, lang text, user_id uuid, created_at timestamptz not null default now())`;
    const recent = (await sql`select count(*)::int as n, count(*) filter (where email=${email})::int as me from ai_requests where created_at > now() - interval '10 minutes'`)[0];
    if (recent.me) return json(res, 200, { ok: true, again: true });
    if (recent.n > 20) return json(res, 429, { error: ar ? 'طلبات كثيرة الآن. حاول بعد قليل.' : 'Too many requests right now. Please try again shortly.' });
    const me = await currentUser(req).catch(() => null);
    await sql`alter table ai_requests add column if not exists service text`;
    await sql`insert into ai_requests(email, name, phone, brand, website, country, lang, user_id, service) values(${email}, ${f.name}, ${f.phone}, ${f.brand}, ${f.website}, ${f.country}, ${ar ? 'ar' : 'en'}, ${me ? me.id : null}, ${service})`;
    if (mailOn()) {
      const team = (process.env.ADMIN_EMAILS || 'admin@optiroas.com').split(',').map(x => x.trim()).filter(Boolean);
      const lines = [`Brand: ${f.brand}`, `Website: ${f.website || '-'}`, `Country: ${(COUNTRIES[f.country] || {}).en}`, `Name: ${f.name || '-'}`, `Email: ${email}`, `Phone / WhatsApp: ${f.phone || '-'}`, `Language: ${ar ? 'Arabic' : 'English'}`];
      for (const t of team) await sendMail({ to: t, subject: `${{ check: 'AI visibility check', reviews: 'Reviews programme', content: 'AI content package', listings: 'Listings and placements' }[service]} request: ${f.brand}`, ...layout({ lang: 'en', title: 'New AI visibility check request', intro: 'Someone asked for a free AI visibility check on optiroas.com.', paras: lines, button: 'Open OptiROAS', link: 'https://www.optiroas.com/#ai-visibility', outro: 'Reply to the client within one working day.' }) }).catch(() => {});
      await sendMail({ to: email, subject: ar ? 'استلمنا طلب فحص الظهور في الذكاء الاصطناعي' : 'We received your AI visibility check request', ...layout({ lang: ar ? 'ar' : 'en',
        title: ar ? 'شكرًا، استلمنا طلبك' : 'Thanks, we have your request',
        intro: ar ? `سنفحص كيف توصي مساعدات الذكاء الاصطناعي بـ ${f.brand} ونتواصل معك خلال يوم عمل واحد بالنتائج والخطوات التالية.` : `We’ll check how AI assistants recommend ${f.brand} and get back to you within one working day with the results and next steps.`,
        button: ar ? 'زر OptiROAS' : 'Visit OptiROAS', link: `https://www.optiroas.com/?lang=${ar ? 'ar' : 'en'}`,
        outro: ar ? 'لديك سؤال؟ ردّ على هذا البريد.' : 'Questions? Just reply to this email.' }) }).catch(() => {});
    }
    return json(res, 200, { ok: true });
  }

  const u = await currentUser(req);
  if (!u) return json(res, 401, { error: 'Sign in first.' });
  if (!aiAllowed(u)) return json(res, 402, { error: 'AI visibility is part of Pro.', code: 'upgrade', allowed: false });
  const b = req.method === 'POST' ? body(req) : {};

  if (action === 'state') return json(res, 200, await state(u));

  if (action === 'setup' && req.method === 'POST') {
    const brand = clean(b.brand, 80);
    if (!brand) return json(res, 400, { error: 'Enter your brand name.' });
    const maxP = team(u) ? 60 : 25;
    const aliases = [...new Set((b.aliases || []).map(x => clean(x, 80)).filter(Boolean))].slice(0, 8);
    const competitors = (b.competitors || []).map(c => ({ name: clean(c.name, 80), aliases: [...new Set((c.aliases || []).map(x => clean(x, 80)).filter(Boolean))].slice(0, 6) })).filter(c => c.name).slice(0, 5);
    const keywords = [...new Set((b.keywords || []).map(x => clean(x, 80)).filter(Boolean))].slice(0, 30);
    const prompts = [...new Set((b.prompts || []).map(x => clean(typeof x === 'string' ? x : x.text, 300)).filter(Boolean))].slice(0, maxP);
    if (!prompts.length) return json(res, 400, { error: 'Add at least one question shoppers ask.' });
    const country = COUNTRIES[b.country] ? b.country : 'SA';
    const facts = String(b.facts || '').trim().slice(0, 2000) || null, catEn = clean(b.category_en, 80) || null, catAr = clean(b.category_ar, 80) || null;
    const website = clean(b.website, 120).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase() || null;
    await sql`insert into ai_brands(user_id, brand, aliases, website, country, competitors, keywords) values(${u.id}, ${brand}, ${JSON.stringify(aliases)}, ${website}, ${country}, ${JSON.stringify(competitors)}, ${JSON.stringify(keywords)})
      on conflict(user_id) do update set brand=excluded.brand, aliases=excluded.aliases, website=excluded.website, country=excluded.country, competitors=excluded.competitors, keywords=excluded.keywords, active=true, updated_at=now()`;
    await sql`update ai_brands set facts=${facts}, category_en=${catEn}, category_ar=${catAr} where user_id=${u.id}`;
    // keep questions that didn't change, so their history stays linked
    const old = await sql`select id, text from ai_prompts where user_id=${u.id}`;
    const keep = new Set(prompts);
    for (const o of old) if (!keep.has(o.text)) await sql`delete from ai_prompts where id=${o.id}`;
    for (const t of prompts) if (!old.some(o => o.text === t)) await sql`insert into ai_prompts(user_id, text, lang) values(${u.id}, ${t}, ${isAr(t) ? 'ar' : 'en'})`;
    // country or keywords changed: the cached keyword data no longer applies
    const kw = (await sql`select country, data from ai_kw where user_id=${u.id}`)[0];
    if (kw && (kw.country !== country || JSON.stringify((kw.data || {}).asked || []) !== JSON.stringify(keywords.length ? keywords : [brand, ...aliases]))) await sql`delete from ai_kw where user_id=${u.id}`;
    return json(res, 200, await state(u));
  }

  if (action === 'run' && req.method === 'POST') {
    const br = (await sql`select last_batch_at from ai_brands where user_id=${u.id}`)[0];
    if (!br) return json(res, 400, { error: 'Set up your brand first.' });
    if (!enginesOn().length) return json(res, 503, { error: 'No AI assistant is switched on yet. Add an API key in Vercel (see setup).' });
    const open = (await sql`select count(*)::int as n from ai_jobs where user_id=${u.id} and status in ('queued','running')`)[0].n;
    if (!open) {
      if (!team(u) && br.last_batch_at && Date.now() - new Date(br.last_batch_at) < 20 * 3600e3) return json(res, 429, { error: 'You can refresh once a day. Results also update automatically every week.' });
      await enqueue(u.id);
    }
    await work({ userId: u.id, ms: 45000 });
    return json(res, 200, await state(u));
  }

  if (action === 'tick' && req.method === 'POST') {
    await work({ userId: u.id, ms: 40000 });
    return json(res, 200, await state(u));
  }

  if (action === 'demand' && req.method === 'POST') {
    const br = (await sql`select * from ai_brands where user_id=${u.id}`)[0];
    if (!br) return json(res, 400, { error: 'Set up your brand first.' });
    const kws = br.keywords && br.keywords.length ? br.keywords : [br.brand, ...(br.aliases || [])];
    const cached = (await sql`select fetched_at, error from ai_kw where user_id=${u.id}`)[0];
    if (cached && !cached.error && Date.now() - new Date(cached.fetched_at) < (team(u) ? 60e3 : 24 * 3600e3)) return json(res, 200, await state(u));
    try {
      const d = await demand(kws, br.country, [br.brand]);
      await sql`insert into ai_kw(user_id, country, data, error, fetched_at) values(${u.id}, ${br.country}, ${JSON.stringify({ ...d, asked: kws })}, null, now())
        on conflict(user_id) do update set country=excluded.country, data=excluded.data, error=null, fetched_at=now()`;
    } catch (e) {
      await sql`insert into ai_kw(user_id, country, data, error, fetched_at) values(${u.id}, ${br.country}, ${JSON.stringify({ asked: kws })}, ${String(e.message).slice(0, 300)}, now())
        on conflict(user_id) do update set country=excluded.country, data=excluded.data, error=excluded.error, fetched_at=now()`;
    }
    return json(res, 200, await state(u));
  }

  if (action === 'ga' && req.method === 'POST') {
    const br = (await sql`select ga_property from ai_brands where user_id=${u.id}`)[0];
    if (!br) return json(res, 400, { error: 'Set up your brand first.' });
    if (b.unlink) { await sql`update ai_brands set ga_property=null, ga_error=null, ga_synced_at=null where user_id=${u.id}`; return json(res, 200, await state(u)); }
    if (!gaEmail()) return json(res, 503, { error: 'Google Analytics connection isn’t switched on yet.' });
    const prop = cleanProperty(b.property || br.ga_property);
    if (!prop) return json(res, 400, { error: 'Enter your GA4 property ID (a number like 312345678).' });
    if (b.property && !br.ga_property) await sql`update ai_brands set ga_property=${prop} where user_id=${u.id}`;
    const e = await syncGa(u.id, prop);
    if (e) {
      if (!br.ga_property) await sql`update ai_brands set ga_property=null where user_id=${u.id}`;
      const msg = e.code === 'access' ? `OptiROAS can’t see property ${prop} yet. In Google Analytics → Admin → Property access management, add ${gaEmail()} as a Viewer, then try again.`
        : e.code === 'property' ? `Google Analytics doesn’t recognise property ${prop}. Copy the Property ID from Admin → Property details (a number, not the G- measurement ID).` : e.message;
      return json(res, 400, { error: msg });
    }
    return json(res, 200, await state(u));
  }

  if (action === 'visits' && req.method === 'POST') {
    if (b.remove) { await sql`delete from ai_visits where user_id=${u.id} and id=${+b.remove}`; return json(res, 200, await state(u)); }
    const text = String(b.text || '');
    if (!text || text.length > 3e6) return json(res, 400, { error: 'Choose a Google Analytics CSV export (up to 3 MB).' });
    let d;
    try { d = parseGa4(text); } catch (e) { return json(res, 400, { error: e.message }); }
    await sql`insert into ai_visits(user_id, start_date, end_date, file, data) values(${u.id}, ${d.start}, ${d.end}, ${clean(b.file, 120)}, ${JSON.stringify(d)})`;
    await sql`delete from ai_visits where user_id=${u.id} and id not in (select id from ai_visits where user_id=${u.id} order by uploaded_at desc limit 12)`;
    return json(res, 200, await state(u));
  }

  if (action === 'reviews' && req.method === 'POST') {
    if (b.remove) await sql`delete from ai_reviews where user_id=${u.id} and id=${+b.remove}`;
    else if (b.refresh) {
      if (!process.env.GOOGLE_PLACES_API_KEY) return json(res, 503, { error: 'Google reviews aren’t switched on yet.' });
      try { await googleReviews(u.id); } catch (e) { return json(res, 400, { error: e.message }); }
    } else {
      const platform = clean(b.platform, 40), rating = b.rating === '' || b.rating == null ? null : +b.rating, count = b.count === '' || b.count == null ? null : Math.round(+b.count);
      if (!platform) return json(res, 400, { error: 'Choose a platform.' });
      if ((rating != null && !(rating >= 0 && rating <= 5)) || (count != null && !(count >= 0))) return json(res, 400, { error: 'Rating must be 0–5 and the number of reviews 0 or more.' });
      await sql`insert into ai_reviews(user_id, platform, rating, count, url) values(${u.id}, ${platform}, ${rating}, ${count}, ${clean(b.url, 300) || null})`;
    }
    return json(res, 200, await state(u));
  }

  if (action === 'placement' && req.method === 'POST') {
    if (b.remove) await sql`delete from ai_placements where user_id=${u.id} and id=${+b.remove}`;
    else { const url = clean(b.url, 400); if (!/\./.test(url)) return json(res, 400, { error: 'Paste the page link.' }); await addPlacement(u.id, url, clean(b.note, 200)); }
    return json(res, 200, await state(u));
  }

  return json(res, 404, { error: 'Unknown action' });
}
