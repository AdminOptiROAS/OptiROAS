import { ensureSchema, sql, json, body, emailOk } from '../_lib/core.js';
import { sendReset, recentTokens } from '../_lib/tokens.js';

// Always answers the same way, so it can't be used to find out which emails have accounts.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const { email: e, lang } = body(req);
  const email = String(e || '').trim().toLowerCase();
  if (!emailOk(email)) return json(res, 400, { error: 'Enter a valid email address.' });
  await ensureSchema();
  const r = await sql`select id,email from users where email=${email}`;
  if (r[0] && (await recentTokens(r[0].id, 'reset')) < 3) await sendReset(r[0], lang);
  return json(res, 200, { ok: true });
}
