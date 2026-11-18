import { sql } from './core.js';
import { isAdmin, isReviewer } from './plan.js';

// AI visibility: how often AI assistants recommend a brand (section 1), Google search demand for its
// keywords (section 2, see ai-demand.js) and visits from AI assistants (section 3, see ai-visits.js).

export const COUNTRIES = {
  SA: { en: 'Saudi Arabia', ar: 'السعودية', geo: 2682 }, AE: { en: 'United Arab Emirates', ar: 'الإمارات', geo: 2784 },
  KW: { en: 'Kuwait', ar: 'الكويت', geo: 2414 }, QA: { en: 'Qatar', ar: 'قطر', geo: 2634 }, BH: { en: 'Bahrain', ar: 'البحرين', geo: 2048 },
  OM: { en: 'Oman', ar: 'عُمان', geo: 2512 }, EG: { en: 'Egypt', ar: 'مصر', geo: 2818 }, US: { en: 'United States', ar: 'الولايات المتحدة', geo: 2840 }
};
const envList = k => (process.env[k] || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
export const aiTeam = u => isAdmin(u) || isReviewer(u);
// Who can use AI visibility: the team, plans in AI_VIS_PLANS (default: pro), or everyone with AI_VIS_OPEN=1
export const aiAllowed = u => !!u && (aiTeam(u) || process.env.AI_VIS_OPEN === '1' || (process.env.AI_VIS_PLANS ? envList('AI_VIS_PLANS') : ['pro']).includes(u.plan || 'free'));
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
function firstHit(text, names) {
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
      const m = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { 'x-goog-api-key': process.env.GEMINI_API_KEY },
        { systemInstruction: { parts: [{ text: sys(c) }] }, contents: [{ role: 'user', parts: [{ text: q }] }], tools: [{ google_search: {} }] });
      const cand = (j.candidates || [])[0] || {};
      // Gemini's source links are redirect URLs; the title holds the site's domain
      const cites = ((cand.groundingMetadata || {}).groundingChunks || []).map(g => g.web).filter(Boolean).map(w => ({ url: w.uri, title: w.title, domain: /\./.test(w.title || '') ? String(w.title).replace(/^www\./, '') : null }));
      return { text: ((cand.content || {}).parts || []).map(p => p.text || '').join(''), cites };
    }
  },
  perplexity: {
    name: 'Perplexity', key: 'PERPLEXITY_API_KEY',
    async ask(q, c) {
      const j = await post('https://api.perplexity.ai/chat/completions', { Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` },
        { model: process.env.PERPLEXITY_MODEL || 'sonar', messages: [{ role: 'system', content: sys(c) }, { role: 'user', content: q }], web_search_options: { user_location: { country: c } } });
      const cites = (j.search_results || []).map(s => ({ url: s.url, title: s.title }));
      return { text: (((j.choices || [])[0] || {}).message || {}).content || '', cites: cites.length ? cites : (j.citations || []).map(u => ({ url: u })) };
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
export async function enqueue(userId) {
  const eng = enginesOn(); if (!eng.length) return { queued: 0, error: 'no-engines' };
  const prompts = await sql`select id, text, lang from ai_prompts where user_id=${userId} order by id`;
  if (!prompts.length) return { queued: 0, error: 'no-prompts' };
  const batch = new Date(); batch.setUTCSeconds(0, 0);
  const rows = prompts.flatMap(p => eng.flatMap(e => Array.from({ length: RUNS() }, (_, i) => [p.id, p.text, p.lang, e, i + 1])));
  for (const [pid, text, lang, e, n] of rows)
    await sql`insert into ai_jobs(user_id, batch, prompt_id, prompt, lang, engine, run_no) values(${userId}, ${batch}, ${pid}, ${text}, ${lang}, ${e}, ${n}) on conflict do nothing`;
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
    await sql`update ai_jobs set status='done', done_at=now(), error=null, answer=${String(r.text || '').slice(0, 6000)}, found=${JSON.stringify(found)}, citations=${JSON.stringify(cites)} where id=${j.id}`;
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
      count(*) filter (where status='error')::int as failed, count(*) filter (where status='done' and (found->>'brand')::int > 0)::int as hit
    from ai_jobs where user_id=${userId} group by batch order by batch desc limit 26`;
  const latest = batches.find(b => b.done + b.failed >= b.n && b.done > 0) || batches.find(b => b.done > 0);
  const progress = batches[0] && batches[0].done + batches[0].failed < batches[0].n ? batches[0] : null;
  const errs = progress || batches[0] ? await sql`select engine, error, count(*)::int as n from ai_jobs where user_id=${userId} and batch=${(progress || batches[0]).batch} and status='error' group by engine, error limit 8` : [];
  const out = { brand, progress, errors: errs, trend: batches.filter(b => b.done).map(b => ({ batch: b.batch, rate: b.hit / b.done, n: b.done })).reverse() };
  if (!latest) return out;
  const rows = await sql`select prompt_id, prompt, lang, engine, run_no, answer, found, citations from ai_jobs where user_id=${userId} and batch=${latest.batch} and status='done' order by prompt_id, engine, run_no`;
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
  return { ...out, batch: latest.batch, total: stat(rows), byEngine: group('engine'), byLang: group('lang'),
    domains: [...dom].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([d, n]) => ({ domain: d, share: n / (rows.length || 1) })), prompts };
}
