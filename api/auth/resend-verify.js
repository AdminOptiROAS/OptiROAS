import { currentUser, json, body } from '../_lib/core.js';
import { sendVerify, recentTokens } from '../_lib/tokens.js';
import { verified } from '../_lib/plan.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  if (verified(user)) return json(res, 200, { ok: true, already: true });
  if ((await recentTokens(user.id, 'verify')) >= 3) return json(res, 429, { error: 'We’ve sent several links in the last hour. Check your inbox and spam folder, or try again later.' });
  const sent = await sendVerify(user, body(req).lang);
  return sent ? json(res, 200, { ok: true }) : json(res, 502, { error: 'We couldn’t send the email just now. Please try again shortly.' });
}
