import { sql } from './core.js';
import { sendMail, layout, KITEO_SITE } from './mail.js';
import { summary, COUNTRIES, host, ENGINES } from './ai.js';

const pct = x => Math.round((x || 0) * 100) + '%';
const eName = k => (ENGINES[k] || {}).name || k;

// ---------- alerts: what changed since the previous complete run ----------
// Called whenever the report is built; does the work once per completed run (ai_brands.alerts_batch).
export async function alertsFor(userId, rep) {
  rep = rep || await summary(userId);
  if (!rep || !rep.batch || rep.progress) return;
  if (rep.brand.alerts_batch && +new Date(rep.brand.alerts_batch) >= +new Date(rep.batch)) return;
  const claim = await sql`update ai_brands set alerts_batch=${rep.batch} where user_id=${userId} and (alerts_batch is null or alerts_batch < ${rep.batch}) returning user_id`;
  if (!claim[0]) return; // another request is already doing it
  const prevB = (await sql`select batch from ai_jobs where user_id=${userId} and kind='market' and status='done' and batch < ${rep.batch} group by batch order by batch desc limit 1`)[0];
  const out = [], add = (kind, good, en, ar) => out.push({ kind, good, en, ar });
  const B = rep.brand.brand, own = rep.total.brands[0];
  if (!prevB) add('first', true, `Your first AI visibility results are ready: ${B} is named in ${pct(own.rate)} of answers.`, `أول نتائج ظهورك في الذكاء الاصطناعي جاهزة: ${B} مذكورة في ${pct(own.rate)} من الإجابات.`);
  else {
    const prev = await sql`select engine, found, brands from ai_jobs where user_id=${userId} and kind='market' and status='done' and batch=${prevB.batch}`;
    const rate = rs => rs.length ? rs.filter(r => (r.found || {}).brand > 0).length / rs.length : 0;
    const pAll = rate(prev), d = own.rate - pAll;
    if (Math.abs(d) >= 0.08) add(d > 0 ? 'sov_up' : 'sov_down', d > 0,
      `${B} share of voice ${d > 0 ? 'rose' : 'fell'} from ${pct(pAll)} to ${pct(own.rate)}.`, `حصة ظهور ${B} ${d > 0 ? 'ارتفعت' : 'انخفضت'} من ${pct(pAll)} إلى ${pct(own.rate)}.`);
    for (const e of Object.keys(rep.byEngine)) {
      const now = rep.byEngine[e].brands[0].rate, was = rate(prev.filter(r => r.engine === e));
      if (was >= 0.15 && now === 0) add('engine_lost', false, `${eName(e)} stopped recommending ${B} (it named you in ${pct(was)} of answers last time).`, `توقّف ${eName(e)} عن ترشيح ${B} (كان يذكرك في ${pct(was)} من الإجابات سابقًا).`);
      else if (was === 0 && now >= 0.15) add('engine_new', true, `${eName(e)} started recommending ${B}: named in ${pct(now)} of answers.`, `بدأ ${eName(e)} بترشيح ${B}: مذكورة في ${pct(now)} من الإجابات.`);
      else if (now - was <= -0.2) add('engine_drop', false, `${eName(e)} recommends ${B} less often: ${pct(was)} → ${pct(now)}.`, `${eName(e)} يرشّح ${B} أقل: ${pct(was)} ← ${pct(now)}.`);
    }
    // competitors overtaking, and new names in the top 10
    for (const c of rep.total.brands.slice(1)) {
      const was = prev.length ? prev.filter(r => ((r.found || {}).comps || {})[c.name]).length / prev.length : 0;
      if (c.rate > own.rate && was <= pAll) add('overtaken', false, `${c.name} is now recommended more often than ${B} (${pct(c.rate)} vs ${pct(own.rate)}).`, `${c.name} يُرشَّح الآن أكثر من ${B} (${pct(c.rate)} مقابل ${pct(own.rate)}).`);
      if (c.rate < own.rate && was > pAll) add('overtook', true, `${B} is now recommended more often than ${c.name}.`, `${B} تُرشَّح الآن أكثر من ${c.name}.`);
    }
    const prevNames = new Set(prev.flatMap(r => (r.brands || []).map(b => String(b.name).toLowerCase())));
    const fresh = (rep.top || []).filter(t => !t.own && !t.comp && t.rate >= 0.1 && !prevNames.has(t.name.toLowerCase())).slice(0, 3);
    for (const t of fresh) add('new_rival', false, `New name in AI answers: ${t.name} appears in ${pct(t.rate)} of answers.`, `اسم جديد في إجابات الذكاء الاصطناعي: ${t.name} يظهر في ${pct(t.rate)} من الإجابات.`);
    const newSrc = ((rep.sources || {}).withYou || []).filter(s => s.isNew).slice(0, 3);
    if (newSrc.length) add('new_source', true, `New websites put ${B} in AI answers: ${newSrc.map(s => s.domain).join(', ')}.`, `مواقع جديدة أدخلت ${B} في إجابات الذكاء الاصطناعي: ${newSrc.map(s => s.domain).join('، ')}.`);
  }
  const S = rep.says;
  // wrong facts: only when the number changed since the previous run (so it doesn't repeat every week)
  let prevWrong = null;
  if (prevB) prevWrong = (await sql`select analysis from ai_jobs where user_id=${userId} and kind='brand' and status='done' and batch=${prevB.batch}`).reduce((n, r) => n + ((r.analysis || {}).claims || []).filter(c => c.status === 'wrong').length, 0);
  if (S && S.wrong && S.wrong !== prevWrong) add('wrong_facts', false, `AI assistants said ${S.wrong} thing${S.wrong === 1 ? '' : 's'} about ${B} that don't match your facts. See "What AI says about you".`, `قالت مساعدات الذكاء الاصطناعي ${S.wrong} معلومة عن ${B} لا تطابق معلوماتك. راجع «ماذا يقول الذكاء الاصطناعي عنك».`);
  if (S && S.unknown) add('unknown', false, `${S.unknown} answer${S.unknown === 1 ? '' : 's'} said the assistant doesn't know ${B} or confused it with another company.`, `${S.unknown} إجابة قالت إن المساعد لا يعرف ${B} أو خلط بينها وبين شركة أخرى.`);
  for (const a of out) await sql`insert into ai_alerts(user_id, batch, kind, good, en, ar) values(${userId}, ${rep.batch}, ${a.kind}, ${a.good}, ${a.en}, ${a.ar})`;
}
export const listAlerts = userId => sql`select id, batch, kind, good, en, ar, created_at from ai_alerts where user_id=${userId} order by batch desc nulls last, id limit 30`;

// ---------- reviews ----------
// Google: Places API (GOOGLE_PLACES_API_KEY) finds the brand's listings in its country and totals rating and count.
// Other platforms (Noon, Amazon, Trustpilot, Salla store…) are entered by the client.
export async function googleReviews(userId) {
  const b = (await sql`select brand, country from ai_brands where user_id=${userId}`)[0];
  if (!b || !process.env.GOOGLE_PLACES_API_KEY) return null;
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY, 'X-Goog-FieldMask': 'places.displayName,places.rating,places.userRatingCount,places.googleMapsUri,places.formattedAddress' },
    body: JSON.stringify({ textQuery: `${b.brand} ${(COUNTRIES[b.country] || COUNTRIES.SA).en}`, regionCode: b.country, maxResultCount: 10 }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `Google Places returned ${r.status}`);
  const places = (j.places || []).filter(p => p.userRatingCount).map(p => ({ name: (p.displayName || {}).text, rating: p.rating, count: p.userRatingCount, url: p.googleMapsUri, address: p.formattedAddress })).slice(0, 10);
  const count = places.reduce((s, p) => s + p.count, 0), rating = count ? places.reduce((s, p) => s + p.rating * p.count, 0) / count : null;
  await sql`insert into ai_reviews(user_id, platform, rating, count, url, source, detail) values(${userId}, 'Google Maps', ${rating ? Math.round(rating * 100) / 100 : null}, ${count}, ${places[0] ? places[0].url : null}, 'google', ${JSON.stringify(places)})`;
  await sql`update ai_brands set places_at=now() where user_id=${userId}`;
  return { rating, count, places };
}
export async function reviewsState(userId) {
  const rows = await sql`select id, platform, rating, count, url, source, detail, recorded_at from ai_reviews where user_id=${userId} order by recorded_at desc limit 200`;
  const by = new Map();
  for (const r of rows) { const a = by.get(r.platform) || []; a.push(r); by.set(r.platform, a); }
  return { google: !!process.env.GOOGLE_PLACES_API_KEY, platforms: [...by].map(([platform, h]) => {
    const now = h[0], month = h.find(x => Date.now() - new Date(x.recorded_at) > 25 * 864e5);
    return { platform, rating: now.rating != null ? +now.rating : null, count: now.count, url: now.url, source: now.source, detail: now.detail, at: now.recorded_at, id: now.id,
      was: month ? { rating: month.rating != null ? +month.rating : null, count: month.count, at: month.recorded_at } : null };
  }) };
}

// ---------- placements the client won (logged by them), and whether AI cites them yet ----------
export async function placementsState(userId, rep) {
  const rows = await sql`select id, url, domain, note, added_at from ai_placements where user_id=${userId} order by added_at desc limit 50`;
  const cited = new Set([...(((rep || {}).sources || {}).withYou || []), ...(((rep || {}).sources || {}).targets || [])].map(s => s.domain));
  const all = new Set(((rep || {}).domains || []).map(d => d.domain));
  return rows.map(r => ({ ...r, inAI: cited.has(r.domain) || all.has(r.domain) }));
}
export const addPlacement = (userId, url, note) => {
  const u = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  return sql`insert into ai_placements(user_id, url, domain, note) values(${userId}, ${u.slice(0, 500)}, ${host(u)}, ${String(note || '').slice(0, 200) || null})`;
};

// ---------- emails ----------
const L = (ar, en, a) => ar ? a : en;
// After a weekly run: the alerts, if there are any new ones.
export async function emailAlerts(userId) {
  const u = (await sql`select email, lang, mkt_unsub_at from users where id=${userId}`)[0];
  const al = await sql`select id, good, en, ar from ai_alerts where user_id=${userId} and not emailed order by id`;
  if (!u || !al.length) return false;
  await sql`update ai_alerts set emailed=true where id = any(${al.map(a => a.id)})`;
  const ar = u.lang === 'ar', b = (await sql`select brand from ai_brands where user_id=${userId}`)[0] || {};
  const m = layout({ lang: ar ? 'ar' : 'en', title: L(ar, `AI visibility update: ${b.brand}`, `تحديث الظهور في الذكاء الاصطناعي: ${b.brand}`),
    intro: L(ar, 'Here’s what changed in this week’s AI answers.', 'إليك ما تغيّر في إجابات الذكاء الاصطناعي هذا الأسبوع.'),
    paras: al.map(a => (a.good ? '▲ ' : '▼ ') + (ar ? a.ar : a.en)),
    button: L(ar, 'Open my AI visibility report', 'افتح تقرير ظهوري'), link: `${KITEO_SITE()}/?lang=${ar ? 'ar' : 'en'}#ai-visibility`, brand: 'kiteo',
    outro: L(ar, 'You get this email when your weekly AI check finds changes.', 'تصلك هذه الرسالة عندما يجد الفحص الأسبوعي تغييرات.') });
  return sendMail({ to: u.email, subject: L(ar, `AI visibility: ${al.length} update${al.length === 1 ? '' : 's'} for ${b.brand}`, `الظهور في الذكاء الاصطناعي: ${al.length} تحديث لـ ${b.brand}`), ...m });
}
// Once a month: progress summary.
export async function emailMonthly(userId) {
  const rep = await summary(userId);
  const u = (await sql`select email, lang from users where id=${userId}`)[0];
  if (!rep || !rep.batch || !u) return false;
  const ar = u.lang === 'ar', B = rep.brand.brand, own = rep.total.brands[0];
  const old = rep.trend.find(t => Date.now() - new Date(t.batch) >= 25 * 864e5) || rep.trend[0];
  const rank = [...rep.total.brands].sort((a, b) => b.rate - a.rate).findIndex(x => x.own) + 1;
  const top3 = (rep.top || []).slice(0, 3).map((t, i) => `${i + 1}. ${t.name} (${pct(t.rate)})`).join('  ');
  const newSrc = ((rep.sources || {}).withYou || []).filter(s => s.isNew).map(s => s.domain);
  const v = (await sql`select data from ai_visits where user_id=${userId} order by uploaded_at desc limit 1`)[0];
  const S = rep.says || {};
  const paras = [
    L(ar, `Share of voice: ${pct(own.rate)} (a month ago: ${pct(old ? old.rate : own.rate)}).`, `حصة الظهور: ${pct(own.rate)} (قبل شهر: ${pct(old ? old.rate : own.rate)}).`),
    L(ar, `Your rank among tracked competitors: ${rank} of ${rep.total.brands.length}.`, `ترتيبك بين المنافسين المتابَعين: ${rank} من ${rep.total.brands.length}.`),
    top3 ? L(ar, `Most recommended in your questions: ${top3}.`, `الأكثر ترشيحًا في أسئلتك: ${top3}.`) : null,
    newSrc.length ? L(ar, `New websites putting you in AI answers: ${newSrc.slice(0, 5).join(', ')}.`, `مواقع جديدة تُدخلك في إجابات الذكاء الاصطناعي: ${newSrc.slice(0, 5).join('، ')}.`) : null,
    S.wrong ? L(ar, `Wrong facts about you in AI answers: ${S.wrong}. Fixing these is a quick win.`, `معلومات خاطئة عنك في الإجابات: ${S.wrong}. تصحيحها مكسب سريع.`) : null,
    v ? L(ar, `Visits from AI assistants (last period): ${v.data.ai.sessions}${v.data.total.sessions ? ` (${pct(v.data.ai.sessions / v.data.total.sessions)} of all visits)` : ''}.`, `الزيارات من مساعدات الذكاء الاصطناعي (آخر فترة): ${v.data.ai.sessions}${v.data.total.sessions ? ` (${pct(v.data.ai.sessions / v.data.total.sessions)} من كل الزيارات)` : ''}.`) : null
  ].filter(Boolean);
  const m = layout({ lang: ar ? 'ar' : 'en', title: L(ar, `Your monthly AI visibility summary: ${B}`, `ملخصك الشهري للظهور في الذكاء الاصطناعي: ${B}`),
    intro: L(ar, 'How AI assistants recommended you this month, and where to focus next.', 'كيف رشّحتك مساعدات الذكاء الاصطناعي هذا الشهر، وأين تركّز بعد ذلك.'), paras,
    button: L(ar, 'See the full report', 'شاهد التقرير الكامل'), link: `${KITEO_SITE()}/?lang=${ar ? 'ar' : 'en'}#ai-visibility`, brand: 'kiteo',
    outro: L(ar, 'Want our team to work on these with you? Just reply to this email.', 'تريد أن يعمل فريقنا عليها معك؟ ردّ على هذا البريد فقط.') });
  const ok = await sendMail({ to: u.email, subject: L(ar, `Monthly AI visibility summary: ${B}`, `الملخص الشهري للظهور في الذكاء الاصطناعي: ${B}`), ...m });
  if (ok) await sql`update ai_brands set monthly_sent_at=now() where user_id=${userId}`;
  return ok;
}
