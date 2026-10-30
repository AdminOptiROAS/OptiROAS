import { ensureSchema, sql, json, body, emailOk, hashPassword, startSession } from '../_lib/core.js';
import { sendVerify } from '../_lib/tokens.js';
import { mailOn } from '../_lib/mail.js';

// Free sign-ups are open. Set INVITE_ONLY=true to limit sign-ups to the emails on ALLOWED_EMAILS.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const { email: e, password, name, lang, utm } = body(req);
  const U = utm && typeof utm === 'object' ? utm : {}, clip = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
  const email = String(e || '').trim().toLowerCase();
  if (!emailOk(email)) return json(res, 400, { error: 'Enter a valid email address.' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) return json(res, 400, { error: 'Use a password of at least 8 characters.' });
  const allow = (process.env.ALLOWED_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.INVITE_ONLY === 'true' && !allow.includes(email)) return json(res, 403, { error: 'Accounts are invite-only during early access. Join the waitlist and we’ll send you an invite.' });
  await ensureSchema();
  const exists = await sql`select 1 from users where email=${email}`;
  if (exists.length) return json(res, 409, { error: 'An account with this email already exists. Sign in instead, or reset your password.' });
  const r = await sql`insert into users(email,name,pass_hash,utm_source,utm_campaign) values(${email},${String(name || '').trim().slice(0, 120) || null},${hashPassword(password)},${clip(U.source)},${clip(U.campaign)}) returning id,email,name`;
  await startSession(res, r[0].id);
  let sent = false;
  if (mailOn() && !allow.includes(email)) sent = await sendVerify(r[0], lang);
  return json(res, 200, { user: r[0], verifySent: sent });
}
