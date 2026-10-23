import { currentUser, sql, json, body } from '../_lib/core.js';
import { cleanSummary, summaryEmail } from '../_lib/report.js';
import { sendMail, mailOn } from '../_lib/mail.js';
import { takeDownload } from '../usage/download.js';

// Emails a report summary to the signed-in user's own address. Either a saved report (id) or a summary sent
// just for this email (data), which is used to build the message and not stored.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in to email reports to yourself.', code: 'signin' });
  if (!mailOn()) return json(res, 503, { error: 'Email isn’t switched on yet. Download the PDF instead for now.', code: 'nomail' });
  const sent = (await sql`select count(*)::int as n from api_log where user_id=${user.id} and endpoint='report:email' and at>now()-interval '1 day'`)[0].n;
  if (sent >= 10) return json(res, 429, { error: 'You’ve emailed 10 reports today. Try again tomorrow.' });
  const b = body(req);
  let d, id = null;
  if (b.id) {
    const r = await sql`select data from saved_reports where id=${String(b.id)} and user_id=${user.id}`;
    if (!r[0]) return json(res, 404, { error: 'That report isn’t in your account.' });
    d = r[0].data; id = String(b.id);
  } else d = cleanSummary(b.data);
  const t = await takeDownload(user, 'summary', (d && d.ref) || b.ref || (id ? 'saved:' + id : ''));
  if (!t.ok) return json(res, 402, { error: 'dl_limit', code: 'dl_limit', kind: 'summary', usage: t.usage });
  const m = summaryEmail(d, { mode: 'report', id });
  const ok = await sendMail({ to: user.email, ...m });
  await sql`insert into api_log(user_id,endpoint,ok) values(${user.id},'report:email',${ok})`;
  if (!ok && t.rowId) await sql`delete from usage_downloads where id=${t.rowId}`; // a failed send doesn't use the allowance
  return ok ? json(res, 200, { ok: true, to: user.email }) : json(res, 502, { error: 'We couldn’t send the email just now. Please try again shortly.' });
}
