// Transactional email through Resend (https://resend.com). Needs RESEND_API_KEY and a verified sending domain.
export const mailOn = () => !!process.env.RESEND_API_KEY;
export const SITE = () => process.env.SITE_URL || 'https://optiroas.com';
const FROM = () => process.env.EMAIL_FROM || 'OptiROAS <noreply@optiroas.com>';
const SUPPORT = 'admin@optiroas.com';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function sendMail({ to, subject, html, text }) {
  if (!mailOn()) { console.error('mail: RESEND_API_KEY not set, email not sent:', subject); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM(), to: [to], subject, html, text, reply_to: SUPPORT })
    });
    if (!r.ok) { console.error('mail: Resend returned', r.status, (await r.text()).slice(0, 300)); return false; }
    return true;
  } catch (e) { console.error('mail:', e.message); return false; }
}

// One simple branded layout, English or Arabic.
export function layout({ lang, title, intro, button, link, outro }) {
  const ar = lang === 'ar', dir = ar ? 'rtl' : 'ltr';
  const html = `<!doctype html><html lang="${ar ? 'ar' : 'en'}" dir="${dir}"><body style="margin:0;background:#f4f7f9;font-family:Segoe UI,Arial,sans-serif;color:#0f1f2b">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;padding:32px;text-align:${ar ? 'right' : 'left'}">
<tr><td style="font-size:22px;font-weight:800;color:#0f1f2b">Opti<span style="color:#0a6c86">ROAS</span></td></tr>
<tr><td style="padding-top:20px;font-size:18px;font-weight:700">${esc(title)}</td></tr>
<tr><td style="padding-top:10px;font-size:15px;line-height:1.6;color:#3d4f5c">${esc(intro)}</td></tr>
<tr><td style="padding:24px 0"><a href="${esc(link)}" style="background:#0a6c86;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block">${esc(button)}</a></td></tr>
<tr><td style="font-size:13px;line-height:1.6;color:#6b7c88">${esc(outro)}<br><br>${ar ? 'إذا لم يعمل الزر، انسخ هذا الرابط:' : 'If the button doesn’t work, copy this link:'}<br><span style="word-break:break-all">${esc(link)}</span></td></tr>
</table><p style="font-size:12px;color:#8a99a4">OptiROAS · ${SUPPORT}</p></td></tr></table></body></html>`;
  const text = `${title}\n\n${intro}\n\n${button}: ${link}\n\n${outro}\n\nOptiROAS · ${SUPPORT}`;
  return { html, text };
}
