import { ensureSchema, sql, json } from '../_lib/core.js';
import { summaryEmail } from '../_lib/report.js';
import { sendMail, mailOn } from '../_lib/mail.js';

// Daily (vercel.json cron): sends each due 7-day follow-up once, listing the actions still open.
export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return json(res, 401, { error: 'Unauthorized' });
  await ensureSchema();
  if (!mailOn()) return json(res, 200, { ok: true, skipped: 'email not configured' });
  const due = await sql`select r.id, r.data, u.email from saved_reports r join users u on u.id=r.user_id
    where r.followup_at is not null and r.followup_at<=now() and r.followup_sent_at is null order by r.followup_at limit 50`;
  let sent = 0;
  for (const r of due) {
    const ok = await sendMail({ to: r.email, ...summaryEmail(r.data, { mode: 'followup', id: r.id }) });
    if (ok) { await sql`update saved_reports set followup_sent_at=now() where id=${r.id}`; sent++; }
  }
  return json(res, 200, { ok: true, due: due.length, sent });
}
