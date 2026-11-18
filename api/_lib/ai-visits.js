// Section 3: visits from AI assistants, read from a Google Analytics 4 export
// (Reports → Acquisition → Traffic acquisition, with "Session source / medium" or "Session source", then Share → Download CSV).
export const AI_SOURCES = [
  ['ChatGPT', /chatgpt|openai/], ['Perplexity', /perplexity/], ['Gemini', /gemini|bard\.google/], ['Copilot', /copilot|bing\.com\/chat|edgeservices/],
  ['Claude', /claude\.ai|anthropic/], ['DeepSeek', /deepseek/], ['Meta AI', /(^|\W)meta\.ai/], ['Grok', /grok|(^|\W)x\.ai/], ['Mistral', /mistral/], ['You.com', /(^|\W)you\.com/]
];
export const aiOf = src => { const s = String(src || '').toLowerCase(); const m = AI_SOURCES.find(([, re]) => re.test(s)); return m ? m[0] : null; };

function rowsOf(text) {
  const out = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}
const num = s => { const n = parseFloat(String(s || '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const ymd = s => /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;

export function parseGa4(text) {
  text = String(text || '').replace(/^﻿/, '');
  let start = null, end = null;
  for (const l of text.split(/\r?\n/).filter(l => l.startsWith('#'))) {
    const m = l.match(/(start|end) date:\s*(\d{8})/i); if (m) (m[1].toLowerCase() === 'start' ? (start = ymd(m[2])) : (end = ymd(m[2])));
  }
  const rows = rowsOf(text.split(/\r?\n/).filter(l => !l.startsWith('#')).join('\n')).filter(r => r.some(c => c.trim()));
  const hi = rows.findIndex(r => r.some(c => /source/i.test(c)) && r.some(c => /sessions/i.test(c)));
  if (hi < 0) { const e = new Error('This doesn’t look like a Google Analytics traffic export. It needs a "Session source" (or "Session source / medium") column and a "Sessions" column.'); e.code = 'format'; throw e; }
  const H = rows[hi].map(c => c.trim().toLowerCase());
  const col = (...res) => { for (const re of res) { const i = H.findIndex(h => re.test(h)); if (i >= 0) return i; } return -1; };
  const cSrc = col(/source/), cSes = col(/^sessions$/, /sessions/), cEng = col(/^engaged sessions$/), cKey = col(/key events/, /conversions/),
    cRev = col(/total revenue/, /purchase revenue/, /revenue/), cPur = col(/^ecommerce purchases$/, /transactions/, /purchases/), cDate = col(/^date$/);
  const by = new Map(), tot = { sessions: 0, engaged: 0, keyEvents: 0, revenue: 0, purchases: 0 }, daily = new Map();
  for (const r of rows.slice(hi + 1)) {
    const src = (r[cSrc] || '').trim();
    if (!src || /^(grand )?total/i.test(src)) continue;
    const v = { sessions: num(r[cSes]), engaged: cEng >= 0 ? num(r[cEng]) : 0, keyEvents: cKey >= 0 ? num(r[cKey]) : 0, revenue: cRev >= 0 ? num(r[cRev]) : 0, purchases: cPur >= 0 ? num(r[cPur]) : 0 };
    for (const k in tot) tot[k] += v[k];
    const ai = aiOf(src); if (!ai) continue;
    const a = by.get(ai) || { name: ai, sessions: 0, engaged: 0, keyEvents: 0, revenue: 0, purchases: 0, sources: [] };
    for (const k in v) a[k] += v[k];
    if (!a.sources.includes(src) && a.sources.length < 5) a.sources.push(src);
    by.set(ai, a);
    if (cDate >= 0) { const d = ymd((r[cDate] || '').trim()); if (d) daily.set(d, (daily.get(d) || 0) + v.sessions); }
  }
  if (!tot.sessions) { const e = new Error('No sessions found in this file.'); e.code = 'format'; throw e; }
  const assistants = [...by.values()].sort((a, b) => b.sessions - a.sessions);
  const ai = assistants.reduce((s, a) => { for (const k in tot) s[k] += a[k]; return s; }, { sessions: 0, engaged: 0, keyEvents: 0, revenue: 0, purchases: 0 });
  return { start, end, total: tot, ai, assistants, has: { engaged: cEng >= 0, keyEvents: cKey >= 0, revenue: cRev >= 0, purchases: cPur >= 0 },
    daily: [...daily].sort().map(([d, n]) => ({ d, n })) };
}
