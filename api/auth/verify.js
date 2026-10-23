import { ensureSchema, sql } from '../_lib/core.js';
import { useToken } from '../_lib/tokens.js';

// Link from the confirmation email.
export default async function handler(req, res) {
  await ensureSchema();
  const token = new URL(req.url, 'https://optiroas.com').searchParams.get('token');
  const uid = await useToken(token, 'verify');
  if (uid) await sql`update users set email_verified_at=coalesce(email_verified_at, now()) where id=${uid}`;
  res.statusCode = 302; res.setHeader('Location', `/?verified=${uid ? '1' : '0'}#account`); res.end();
}
