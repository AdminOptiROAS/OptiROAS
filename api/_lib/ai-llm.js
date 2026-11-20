// Small structured-extraction calls on top of the assistants' answers (Claude, no web search).
// Used to (1) list every brand/store an answer recommends, in order, and (2) check what an answer says about the client's brand.
const MODEL = () => process.env.ANALYSIS_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';

async function claudeJson(prompt, maxTokens = 900) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL(), max_tokens: maxTokens, system: 'You extract structured data from text. Reply with one JSON object and nothing else.', messages: [{ role: 'user', content: prompt }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `analysis HTTP ${r.status}`);
  const t = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const m = t.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

// Every brand, store or retailer an answer recommends or names as an option, in order of first appearance.
export async function extractBrands(question, answer) {
  if (!answer || answer.length < 20) return [];
  const j = await claudeJson(`A shopper asked an AI assistant: "${question}"
Below is the assistant's answer. List every brand, store or online retailer that the answer recommends or names as an option to buy, in the order they first appear.
Write each name as it appears in the answer (keep Arabic names in Arabic). Use the brand name, not a full product model, unless only a model is given. Do not list websites that are only cited as sources.
JSON: {"brands":[{"name":"...","type":"brand"|"store"}]}

Answer:
${String(answer).slice(0, 6000)}`, 700);
  return ((j && j.brands) || []).filter(b => b && b.name).slice(0, 25).map(b => ({ name: String(b.name).slice(0, 80), type: b.type === 'store' ? 'store' : 'brand' }));
}

// What the answer says about the brand: one-line summary, sentiment, and factual claims checked against the brand's own facts.
export async function checkClaims({ brand, facts, country, question, answer, lang }) {
  if (!answer) return null;
  const j = await claudeJson(`Brand: ${brand}
Country: ${country}
Official facts provided by the brand (may be empty): ${facts ? String(facts).slice(0, 2000) : '(none provided)'}

An AI assistant was asked: "${question}"
Its answer is below. Analyse what it says about ${brand}:
- "summary": one sentence in ${lang === 'ar' ? 'Arabic' : 'English'} describing how the answer presents ${brand}.
- "sentiment": "positive", "neutral", "negative" or "mixed".
- "known": false if the answer says it doesn't know ${brand}, has no information, or confuses it with a different company; otherwise true.
- "claims": up to 6 factual claims the answer makes about ${brand} (prices, products, where to buy, branches, delivery, warranty, quality, reputation). Write each claim in ${lang === 'ar' ? 'Arabic' : 'English'}. For each, "status": "matches" if it agrees with the official facts, "wrong" if it contradicts them, "unverified" if the facts don't cover it. For "wrong", add "fix": what is actually correct according to the facts.
JSON: {"summary":"","sentiment":"","known":true,"claims":[{"claim":"","status":"","fix":""}]}

Answer:
${String(answer).slice(0, 6000)}`, 1200);
  if (!j) return null;
  const S = ['positive', 'neutral', 'negative', 'mixed'];
  return {
    summary: String(j.summary || '').slice(0, 400), sentiment: S.includes(j.sentiment) ? j.sentiment : 'neutral', known: j.known !== false,
    claims: (j.claims || []).filter(c => c && c.claim).slice(0, 6).map(c => ({ claim: String(c.claim).slice(0, 300), status: ['matches', 'wrong', 'unverified'].includes(c.status) ? c.status : 'unverified', fix: c.fix ? String(c.fix).slice(0, 300) : '' }))
  };
}
