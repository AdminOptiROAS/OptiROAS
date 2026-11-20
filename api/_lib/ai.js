import { sql } from './core.js';
import { isAdmin, isReviewer } from './plan.js';
import { extractBrands, checkClaims } from './ai-llm.js';

// AI visibility: how often AI assistants recommend a brand (section 1), Google search demand for its
// keywords (section 2, see ai-demand.js) and visits from AI assistants (section 3, see ai-visits.js).

export const COUNTRIES = {
  SA: { en: 'Saudi Arabia', ar: 'السعودية', geo: 2682 }, AE: { en: 'United Arab Emirates', ar: 'الإمارات', geo: 2784 },
  KW: { en: 'Kuwait', ar: 'الكويت', geo: 2414 }, QA: { en: 'Qatar', ar: 'قطر', geo: 2634 }, BH: { en: 'Bahrain', ar: 'البحرين', geo: 2048 },
  OM: { en: 'Oman', ar: 'عُمان', geo: 2512 }, EG: { en: 'Egypt', ar: 'مصر', geo: 2818 }, US: { en: 'United States', ar: 'الولايات المتحدة', geo: 2840 }
};
const envList = k => (process.env[k] || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
export const aiTeam = u => isAdmin(u) || isReviewer(u);
// Who can use AI visibility: the team, testers in AI_VIS_EMAILS, plans in AI_VIS_PLANS (default: pro), or everyone with AI_VIS_OPEN=1
export const aiAllowed = u => !!u && (aiTeam(u) || envList('AI_VIS_EMAILS').includes(String(u.email || '').toLowerCase()) || process.env.AI_VIS_OPEN === '1' || (process.env.AI_VIS_PLANS ? envList('AI_VIS_PLANS') : ['pro']).includes(u.plan || 'free'));
export const RUNS = () => Math.min(3, Math.max(1, parseInt(process.env.AI_RUNS_PER_PROMPT || '2', 10) || 2));

let ready;
export function ensureAi() {
  ready = ready || (async () => {
    await sql`create table if not exists ai_brands(
      user_id uuid primary key references users(id) on delete cascade, brand text not null, aliases jsonb not null default '[]',
      website text, country text not null default 'SA', competitors jsonb not null default '[]', keywords jsonb not null default '[]',
      active boolean not null default true, last_batch_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
    await sql`create table if not exists ai_prompts(
      id bigserial primary key, user_id uuid not null references users(id) on delete cascade, text text not null, lang text not null,
      created_at timestamptz not null default now())`;
    await sql`create index if not exists ai_prompts_user on ai_prompts(user_id)`;
    await sql`create table if not exists ai_jobs(
      id bigserial primary key, user_id uuid not null references users(id) on delete cascade, batch timestamptz not null,
      prompt_id bigint references ai_prompts(id) on delete set null, prompt text not null, lang text not null, engine text not null, run_no int not null,
      status text not null default 'queued', attempts int not null default 0, started_at timestamptz, done_at timestamptz, error text,
      answer text, found jsonb, citations jsonb, unique(user_id, batch, prompt_id, engine, run_no))`;
    await sql`create index if not exists ai_jobs_queue on ai_jobs(status, id)`;
    await sql`create index if not exists ai_jobs_user on ai_jobs(user_id, batch)`;
    await sql`create table if not exists ai_kw(
      user_id uuid not null references users(id) on delete cascade, country text not null, data jsonb not null, error text,
      fetched_at timestamptz not null default now(), primary key(user_id))`;
    await sql`create table if not exists ai_visits(
      id bigserial primary key, user_id uuid not null references users(id) on delete cascade, start_date date, end_date date,
      file text, data jsonb not null, uploaded_at timestamptz not null default now())`;
    await sql`create index if not exists ai_visits_user on ai_visits(user_id, uploaded_at desc)`;
    await sql`alter table ai_brands add column if not exists ga_property text`;
    await sql`alter table ai_brands add column if not exists ga_synced_at timestamptz`;
    await sql`alter table ai_brands add column if not exists ga_error text`;
    // v2: brand facts, product category (for seasonal questions), alerts and email bookkeeping
    for (const q of [sql`alter table ai_brands add column if not exists facts text`, sql`alter table ai_brands add column if not exists category_en text`,
      sql`alter table ai_brands add column if not exists category_ar text`, sql`alter table ai_brands add column if not exists alerts_batch timestamptz`,
      sql`alter table ai_brands add column if not exists monthly_sent_at timestamptz`, sql`alter table ai_brands add column if not exists places_at timestamptz`,
      sql`alter table ai_jobs add column if not exists kind text not null default 'market'`, sql`alter table ai_jobs add column if not exists brands jsonb`,
      sql`alter table ai_jobs add column if not exists analysis jsonb`, sql`alter table ai_prompts add column if not exists tag text`]) await q;
    await sql`create table if not exists ai_alerts(id bigserial primary key, user_id uuid not null references users(id) on delete cascade, batch timestamptz,
      kind text not null, good boolean not null default false, en text not null, ar text not null, emailed boolean not null default false, created_at timestamptz not null default now())`;
    await sql`create index if not exists ai_alerts_user on ai_alerts(user_id, created_at desc)`;
    await sql`create table if not exists ai_reviews(id bigserial primary key, user_id uuid not null references users(id) on delete cascade, platform text not null,
      rating numeric, count int, url text, source text not null default 'manual', detail jsonb, recorded_at timestamptz not null default now())`;
    await sql`create index if not exists ai_reviews_user on ai_reviews(user_id, platform, recorded_at desc)`;
    await sql`create table if not exists ai_placements(id bigserial primary key, user_id uuid not null references users(id) on delete cascade, url text not null,
      domain text, note text, added_at timestamptz not null default now())`;
  })().catch(e => { ready = null; throw e; });
  return ready;
}

// ---------- text matching (Arabic and Latin) ----------
export function norm(s) {
  return ' ' + String(s || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[ـ]/g, '').replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim() + ' ';
}
// Arabic attaches و/ب/ل/ف/ك and ال to the next word; also accept those prefixes before a name
const PREFIX = ['', 'و', 'ب', 'ل', 'ف', 'ك', 'وب', 'ول', 'ال', 'وال', 'بال', 'لل', 'فال'];
export function firstHit(text, names) {
  let best = -1;
  for (const n of names) {
    const a = norm(n).trim(); if (!a) continue;
    const ar = /[؀-ۿ]/.test(a[0]);
    for (const p of ar ? PREFIX : ['']) {
      const i = text.indexOf(' ' + p + a + ' ');
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
  }
  return best;
}
export const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

// Which of the brand and its competitors an answer names, in the order they first appear (1 = named first).
export function analyse(answer, brand, citations) {
  const t = norm(answer);
  const all = [{ name: brand.brand, names: [brand.brand, ...(brand.aliases || [])], own: true },
    ...(brand.competitors || []).map(c => ({ name: c.name, names: [c.name, ...(c.aliases || [])] }))];
  const hits = all.map(x => ({ ...x, at: firstHit(t, x.names) })).filter(x => x.at >= 0).sort((a, b) => a.at - b.at);
  const site = host(brand.website && !/^https?:/.test(brand.website) ? 'https://' + brand.website : brand.website);
  const doms = [...new Set((citations || []).map(c => c.domain || host(c.url)).filter(Boolean))];
  return {
    brand: hits.findIndex(h => h.own) + 1 || 0,
    comps: Object.fromEntries(hits.filter(h => !h.own).map(h => [h.name, hits.indexOf(h) + 1])),
    named: hits.length,
    cited: !!(site && doms.some(d => d === site || d.endsWith('.' + site)))
  };
}

// ---------- the assistants ----------
const T = ms => AbortSignal.timeout(ms);
const sys = c => `The user is a shopper located in ${(COUNTRIES[c] || COUNTRIES.SA).en}.`;
async function post(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: T(110000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const m = (j.error && (j.error.message || j.error.type)) || j.message || `HTTP ${r.status}`; const e = new Error(String(m).slice(0, 240)); e.status = r.status; throw e; }
  return j;
}
export const ENGINES = {
  chatgpt: {
    name: 'ChatGPT', key: 'OPENAI_API_KEY',
    async ask(q, c) {
      const j = await post('https://api.openai.com/v1/responses', { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        { model: process.env.OPENAI_MODEL || 'gpt-5-mini', instructions: sys(c), input: q, tools: [{ type: 'web_search', user_location: { type: 'approximate', country: c } }] });
      const parts = (j.output || []).filter(o => o.type === 'message').flatMap(o => o.content || []).filter(p => p.type === 'output_text');
      return { text: parts.map(p => p.text).join('\n'), cites: parts.flatMap(p => (p.annotations || []).filter(a => a.url).map(a => ({ url: a.url, title: a.title }))) };
    }
  },
  gemini: {
    name: 'Gemini', key: 'GEMINI_API_KEY',
    async ask(q, c) {
      const m = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
      const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { 'x-goog-api-key': process.env.GEMINI_API_KEY },
        { systemInstruction: { parts: [{ text: sys(c) }] }, contents: [{ role: 'user', parts: [{ text: q }] }], tools: [{ google_search: {} }] });
      const cand = (j.candidates || [])[0] || {};
      // Gemini's source links are redirect URLs; the title holds the site's domain
      const cites = ((cand.groundingMetadata || {}).groundingChunks || []).map(g => g.web).filter(Boolean).map(w => ({ url: w.uri, title: w.title, domain: /\./.test(w.title || '') ? String(w.title).replace(/^www\./, '') : null }));
      return { text: ((cand.content || {}).parts || []).map(p => p.text || '').join(''), cites };
    }
  },
  perplexity: {
    // Perplexity's Agent API (replaced Sonar chat completions). effort 'fast' = the old 'sonar'.
    name: 'Perplexity', key: 'PERPLEXITY_API_KEY',
    async ask(q, c) {
      const h = { Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` }, eff = process.env.PERPLEXITY_EFFORT || 'fast';
      const req = loc => post('https://api.perplexity.ai/v1/responses', h, { effort: eff, instructions: sys(c), input: q, tools: [loc ? { type: 'web_search', user_location: { country: c } } : { type: 'web_search' }] });
      let j;
      try { j = await req(true); } catch (e) { if (e.status === 400 && /location/i.test(e.message)) j = await req(false); else throw e; }
      const out = j.output || [];
      const text = j.output_text || out.filter(o => o.type === 'message').flatMap(o => o.content || []).filter(p => p.type === 'output_text').map(p => p.text).join('\n');
      const cites = out.filter(o => o.type === 'search_results').flatMap(o => o.results || []).filter(r => r.url).map(r => ({ url: r.url, title: r.title }));
      return { text: String(text || '').replace(/\[(web:)?\d+\]/g, ''), cites };
    }
  },
  claude: {
    name: 'Claude', key: 'ANTHROPIC_API_KEY',
    async ask(q, c) {
      const j = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        { model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens: 1500, system: sys(c), messages: [{ role: 'user', content: q }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', country: c } }] });
      const tx = (j.content || []).filter(b => b.type === 'text');
      return { text: tx.map(b => b.text).join(''), cites: tx.flatMap(b => (b.citations || []).filter(x => x.url).map(x => ({ url: x.url, title: x.title }))) };
    }
  }
};
export const enginesOn = () => Object.keys(ENGINES).filter(k => process.env[ENGINES[k].key]);

// ---------- background jobs ----------
// A batch = every prompt × every assistant with a key × RUNS repeats. The hourly cron starts a weekly batch per brand
// and works through the queue; "Run now" and the open page also work through it, a few answers at a time.
export function brandQuestions(brand, country) {
  const c = COUNTRIES[country] || COUNTRIES.SA;
  return [
    { lang: 'en', text: `What is ${brand}? What do they sell, and are they any good?` },
    { lang: 'en', text: `Where can I buy ${brand} in ${c.en}, and what are the prices like?` },
    { lang: 'en', text: `What do customers say about ${brand}? Give the pros and cons.` },
    { lang: 'ar', text: `ما هي ${brand}؟ ماذا تبيع، وهل هي جيدة؟` },
    { lang: 'ar', text: `من وين أشتري ${brand} في ${c.ar}، وكم أسعارها؟` },
    { lang: 'ar', text: `ماذا يقول العملاء عن ${brand}؟ اذكر المميزات والعيوب.` }
  ];
}

export async function enqueue(userId) {
  const eng = enginesOn(); if (!eng.length) return { queued: 0, error: 'no-engines' };
  const prompts = await sql`select id, text, lang from ai_prompts where user_id=${userId} order by id`;
  if (!prompts.length) return { queued: 0, error: 'no-prompts' };
  const batch = new Date(); batch.setUTCSeconds(0, 0);
  const rows = prompts.flatMap(p => eng.flatMap(e => Array.from({ length: RUNS() }, (_, i) => [p.id, p.text, p.lang, e, i + 1])));
  for (const [pid, text, lang, e, n] of rows)
    await sql`insert into ai_jobs(user_id, batch, prompt_id, prompt, lang, engine, run_no) values(${userId}, ${batch}, ${pid}, ${text}, ${lang}, ${e}, ${n}) on conflict do nothing`;
  // "What AI says about you": the same few direct questions about the brand, in Arabic and English, once per assistant
  const br = (await sql`select brand, country from ai_brands where user_id=${userId}`)[0];
  if (br) for (const q of brandQuestions(br.brand, br.country)) for (const e of eng)
    await sql`insert into ai_jobs(user_id, batch, prompt_id, prompt, lang, engine, run_no, kind) values(${userId}, ${batch}, null, ${q.text}, ${q.lang}, ${e}, 1, 'brand')`;
  await sql`update ai_brands set last_batch_at=${batch} where user_id=${userId}`;
  return { queued: rows.length, batch };
}

async function runJob(j) {
  const brand = (await sql`select * from ai_brands where user_id=${j.user_id}`)[0];
  if (!brand) { await sql`update ai_jobs set status='error', error='brand removed', done_at=now() where id=${j.id}`; return; }
  const E = ENGINES[j.engine];
  try {
    if (!E || !process.env[E.key]) throw new Error('No API key for ' + j.engine);
    const r = await E.ask(j.prompt, brand.country);
    const cites = (r.cites || []).slice(0, 25).map(c => ({ url: String(c.url || '').slice(0, 500), title: String(c.title || '').slice(0, 200), domain: c.domain || host(c.url) }));
    const found = analyse(r.text, brand, cites);
    // second pass (best effort): every brand the answer recommends, or what it says about the client's brand
    let brands = null, analysis = null;
    try {
      if (j.kind === 'brand') analysis = await checkClaims({ brand: brand.brand, facts: brand.facts, country: (COUNTRIES[brand.country] || COUNTRIES.SA).en, question: j.prompt, answer: r.text, lang: j.lang });
      else brands = await extractBrands(j.prompt, r.text);
    } catch (e) { /* the answer still counts without the extra analysis */ }
    await sql`update ai_jobs set status='done', done_at=now(), error=null, answer=${String(r.text || '').slice(0, 6000)}, found=${JSON.stringify(found)}, citations=${JSON.stringify(cites)},
      brands=${brands ? JSON.stringify(brands) : null}, analysis=${analysis ? JSON.stringify(analysis) : null} where id=${j.id}`;
  } catch (e) {
    const fin = j.attempts >= 3 || e.status === 401 || e.status === 403;
    await sql`update ai_jobs set status=${fin ? 'error' : 'queued'}, error=${String(e.message).slice(0, 300)}, done_at=${fin ? new Date() : null} where id=${j.id}`;
  }
}

// Works through queued answers until the time budget runs out. userId limits it to one account (the open page).
export async function work({ userId = null, ms = 50000, parallel = 6 } = {}) {
  const end = Date.now() + ms; let done = 0;
  while (Date.now() < end - 15000) {
    const jobs = userId
      ? await sql`update ai_jobs set status='running', started_at=now(), attempts=attempts+1 where id in (
          select id from ai_jobs where user_id=${userId} and (status='queued' or (status='running' and started_at < now() - interval '4 minutes'))
          order by id limit ${parallel} for update skip locked) returning *`
      : await sql`update ai_jobs set status='running', started_at=now(), attempts=attempts+1 where id in (
          select id from ai_jobs where status='queued' or (status='running' and started_at < now() - interval '4 minutes')
          order by id limit ${parallel} for update skip locked) returning *`;
    if (!jobs.length) break;
    await Promise.all(jobs.map(runJob)); done += jobs.length;
  }
  return done;
}

// ---------- the report ----------
export async function summary(userId) {
  const brand = (await sql`select * from ai_brands where user_id=${userId}`)[0];
  if (!brand) return null;
  const batches = await sql`select batch, count(*)::int as n, count(*) filter (where status='done')::int as done,
      count(*) filter (where status='error')::int as failed, count(*) filter (where status='done' and kind='market' and (found->>'brand')::int > 0)::int as hit,
      count(*) filter (where status='done' and kind='market')::int as mdone
    from ai_jobs where user_id=${userId} group by batch order by batch desc limit 26`;
  const latest = batches.find(b => b.done + b.failed >= b.n && b.done > 0) || batches.find(b => b.done > 0);
  const progress = batches[0] && batches[0].done + batches[0].failed < batches[0].n ? batches[0] : null;
  const errs = progress || batches[0] ? await sql`select engine, error, count(*)::int as n from ai_jobs where user_id=${userId} and batch=${(progress || batches[0]).batch} and status='error' group by engine, error limit 8` : [];
  const out = { brand, progress, errors: errs, trend: batches.filter(b => b.mdone).map(b => ({ batch: b.batch, rate: b.hit / b.mdone, n: b.mdone })).reverse() };
  if (!latest) return out;
  const all = await sql`select prompt_id, prompt, lang, engine, run_no, answer, found, citations, kind, brands, analysis from ai_jobs where user_id=${userId} and batch=${latest.batch} and status='done' order by prompt_id, engine, run_no, id`;
  const rows = all.filter(r => r.kind !== 'brand'), brandRows = all.filter(r => r.kind === 'brand');
  const names = [brand.brand, ...(brand.competitors || []).map(c => c.name)];
  const stat = rs => {
    const n = rs.length || 1, f = r => r.found || {};
    const by = name => {
      const own = name === brand.brand, ps = rs.map(r => own ? f(r).brand : (f(r).comps || {})[name]).filter(x => x > 0);
      return { name, own, rate: ps.length / n, avgPos: ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null, first: ps.filter(x => x === 1).length / n };
    };
    return { answers: rs.length, cited: rs.filter(r => f(r).cited).length / n, brands: names.map(by) };
  };
  const group = key => Object.fromEntries([...new Set(rows.map(r => r[key]))].map(k => [k, stat(rows.filter(r => r[key] === k))]));
  const dom = new Map();
  for (const r of rows) for (const d of new Set((r.citations || []).map(c => c.domain).filter(Boolean))) dom.set(d, (dom.get(d) || 0) + 1);
  const prompts = [...new Set(rows.map(r => r.prompt_id))].map(id => {
    const rs = rows.filter(r => r.prompt_id === id);
    return {
      id, text: rs[0].prompt, lang: rs[0].lang, ...stat(rs),
      engines: [...new Set(rs.map(r => r.engine))].map(e => {
        const er = rs.filter(r => r.engine === e), hit = er.find(r => (r.found || {}).brand > 0) || er[0];
        return { engine: e, runs: er.length, hits: er.filter(r => (r.found || {}).brand > 0).length, comps: [...new Set(er.flatMap(r => Object.keys((r.found || {}).comps || {})))],
          answer: (hit.answer || '').slice(0, 1800), sources: [...new Set((hit.citations || []).map(c => c.domain).filter(Boolean))].slice(0, 6) };
      })
    };
  });
  const earlier = await sql`select citations, found from ai_jobs where user_id=${userId} and kind='market' and status='done' and batch < ${latest.batch} and batch > ${latest.batch}::timestamptz - interval '120 days'`;
  return { ...out, batch: latest.batch, total: stat(rows), byEngine: group('engine'), byLang: group('lang'),
    domains: [...dom].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([d, n]) => ({ domain: d, share: n / (rows.length || 1) })), prompts,
    top: topBrands(rows, brand), says: brandSays(brandRows), sources: sourcesFor(rows, earlier) };
}

// ---------- top brands across the client's questions ----------
// Names come from the analysis pass; the client's brand and tracked competitors are merged by their spellings.
export function topBrands(rows, brand) {
  const known = [{ name: brand.brand, names: [brand.brand, ...(brand.aliases || [])], own: true }, ...(brand.competitors || []).map(c => ({ name: c.name, names: [c.name, ...(c.aliases || [])], comp: true }))];
  const canon = raw => {
    const t = norm(raw);
    for (const k of known) if (firstHit(t, k.names) >= 0 || k.names.some(n => firstHit(norm(n), [raw]) >= 0)) return { key: 'k:' + k.name, name: k.name, own: !!k.own, comp: !!k.comp };
    return { key: t.trim(), name: String(raw).trim() };
  };
  const agg = new Map(), n = rows.length || 1;
  for (const r of rows) {
    const list = r.brands || [], seen = new Set();
    // answers analysed before v2 (or where the analysis failed) still count the tracked names
    const names = list.length ? list.map(b => b.name) : [...((r.found || {}).brand ? [brand.brand] : []), ...Object.keys((r.found || {}).comps || {})];
    names.forEach((nm, i) => {
      const c = canon(nm); if (!c.key || seen.has(c.key)) return; seen.add(c.key);
      const a = agg.get(c.key) || { name: c.name, own: c.own, comp: c.comp, hits: 0, pos: 0, forms: new Map(), type: (list[i] || {}).type || 'brand' };
      a.hits++; a.pos += seen.size; a.forms.set(nm, (a.forms.get(nm) || 0) + 1); agg.set(c.key, a);
    });
  }
  return [...agg.values()].map(a => ({ name: a.own || a.comp ? a.name : [...a.forms].sort((x, y) => y[1] - x[1])[0][0], own: !!a.own, comp: !!a.comp, type: a.type, rate: a.hits / n, avgPos: a.pos / a.hits }))
    .sort((a, b) => b.rate - a.rate || a.avgPos - b.avgPos).slice(0, 10);
}

// ---------- what AI says about the brand ----------
export function brandSays(rows) {
  if (!rows.length) return null;
  const qs = [...new Set(rows.map(r => r.prompt))];
  const an = rows.map(r => r.analysis).filter(Boolean);
  const sent = { positive: 0, neutral: 0, negative: 0, mixed: 0 }; an.forEach(a => sent[a.sentiment] = (sent[a.sentiment] || 0) + 1);
  const wrong = an.flatMap(a => (a.claims || []).filter(c => c.status === 'wrong'));
  return { answers: rows.length, analysed: an.length, sentiment: sent, unknown: an.filter(a => a.known === false).length, wrong: wrong.length,
    questions: qs.map(q => ({ text: q, lang: rows.find(r => r.prompt === q).lang,
      engines: rows.filter(r => r.prompt === q).map(r => ({ engine: r.engine, answer: (r.answer || '').slice(0, 1500), analysis: r.analysis,
        sources: [...new Set((r.citations || []).map(c => c.domain).filter(Boolean))].slice(0, 5) })) })) };
}

// ---------- placements: which websites put the brand in AI answers ----------
// "with you": sources cited in answers that name the brand (new = not seen in earlier runs).
// "targets": sources cited in answers that name a competitor but not the brand.
export function sourcesFor(rows, earlier) {
  const doms = r => [...new Set((r.citations || []).map(c => c.domain).filter(Boolean))];
  const before = new Set(earlier.filter(r => (r.found || {}).brand > 0).flatMap(doms));
  const withYou = new Map(), targets = new Map();
  for (const r of rows) {
    const f = r.found || {}, ds = doms(r);
    if (f.brand > 0) ds.forEach(d => withYou.set(d, (withYou.get(d) || 0) + 1));
    else if (Object.keys(f.comps || {}).length) ds.forEach(d => targets.set(d, (targets.get(d) || 0) + 1));
  }
  const n = rows.length || 1;
  return {
    withYou: [...withYou].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([d, c]) => ({ domain: d, share: c / n, isNew: earlier.length > 0 && !before.has(d) })),
    targets: [...targets].filter(([d]) => !withYou.has(d)).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([d, c]) => ({ domain: d, share: c / n }))
  };
}
