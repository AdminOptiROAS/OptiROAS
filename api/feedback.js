import { ensureSchema, sql, json, body, currentUser, emailOk } from './_lib/core.js';
import { sendMail, mailOn } from './_lib/mail.js';

// Stores feedback from the site widget and emails it to the team when email is set up.
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const b = body(req), msg = String(b.message || '').trim().slice(0, 4000), rating = Math.max(0, Math.min(5, parseInt(b.rating, 10) || 0));
  if (!msg && !rating) return json(res, 400, { error: 'Add a rating or a message.' });
  if (String(b.website || '')) return json(res, 200, { ok: true }); // honeypot
  await ensureSchema();
  const user = await currentUser(req).catch(() => null);
  const email = emailOk(String(b.email || '').trim()) ? String(b.email).trim().slice(0, 200) : (user ? user.email : null);
  const recent = (await sql`select count(*)::int as n from feedback where created_at>now()-interval '1 minute'`)[0].n;
  if (recent > 30) return json(res, 429, { error: 'Too many messages right now. Please try again in a minute.' });
  await sql`insert into feedback(user_id,email,rating,message,page,lang,ua) values(${user ? user.id : null},${email},${rating || null},${msg},${String(b.page || '').slice(0, 200)},${b.lang === 'ar' ? 'ar' : 'en'},${String(req.headers['user-agent'] || '').slice(0, 200)})`;
  if (mailOn()) {
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    await sendMail({ to: process.env.FEEDBACK_TO || 'admin@optiroas.com', subject: `OptiROAS feedback${rating ? ` · ${rating}/5` : ''}${b.page ? ` · ${String(b.page).slice(0, 40)}` : ''}`,
      html: `<p><b>Rating:</b> ${rating || '—'}/5<br><b>From:</b> ${esc(email || 'anonymous')}<br><b>Page:</b> ${esc(b.page || '')}<br><b>Language:</b> ${b.lang === 'ar' ? 'Arabic' : 'English'}</p><p style="white-space:pre-wrap">${esc(msg)}</p>`,
      text: `Rating: ${rating || '-'}/5\nFrom: ${email || 'anonymous'}\nPage: ${b.page || ''}\n\n${msg}` });
  }
  return json(res, 200, { ok: true });
}
