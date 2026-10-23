// Saved report summaries: validation and the email layout. Summaries hold text and numbers only, never files or rows.
import { SITE } from './mail.js';
const S = (v, n = 400) => String(v ?? '').slice(0, n);
const N = v => { const x = +v; return Number.isFinite(x) ? x : 0; };
export function cleanSummary(d) {
  d = d && typeof d === 'object' ? d : {};
  const findings = (Array.isArray(d.findings) ? d.findings : []).slice(0, 80).map(f => ({
    k: S(f.k, 300), title: S(f.title, 300), problem: S(f.problem, 300), plat: S(f.plat, 20), sev: S(f.sev, 20), pil: S(f.pil, 60), act: S(f.act, 800),
    impact: S(f.impact, 120), bucket: S(f.bucket, 20), h: S(f.h, 10), done: !!f.done, doneAt: f.done ? S(f.doneAt || new Date().toISOString(), 40) : null }));
  const plan = (Array.isArray(d.plan) ? d.plan : []).slice(0, 30).map(p => ({ h: S(p.h, 40), t: S(p.t, 300), tag: S(p.tag, 20) }));
  return { label: S(d.label, 160), period: S(d.period, 80), cur: S(d.cur, 8), score: Math.round(N(d.score)), band: S(d.band, 60),
    total: N(d.total), monthly: N(d.monthly), waste: N(d.waste), roas: N(d.roas), margin: N(d.margin), marginSet: !!d.marginSet, by: S(d.by, 120), upside: S(d.upside, 80), plats: (Array.isArray(d.plats) ? d.plats : []).slice(0, 10).map(x => S(x, 30)),
    findings, plan, lang: d.lang === 'ar' ? 'ar' : 'en' };
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (v, c) => `${c || ''} ${Math.round(v).toLocaleString('en-US')}`.trim();
// Builds the HTML/text email for a summary. mode 'report' (full) or 'followup' (open actions only).
export function summaryEmail(d, { mode = 'report', id } = {}) {
  const ar = d.lang === 'ar', T = (en, a) => ar ? a : en, dir = ar ? 'rtl' : 'ltr', al = ar ? 'right' : 'left';
  const open = d.findings.filter(f => !f.done), done = d.findings.filter(f => f.done);
  const list = mode === 'followup' ? open : d.findings;
  const link = id ? `${SITE()}/?report=${id}#account` : `${SITE()}/`;
  const rows = list.slice(0, 25).map((f, i) => `<tr><td style="padding:10px 0;border-top:1px solid #e3e8ec;vertical-align:top;width:28px;color:#6b7c88">${i + 1}</td>
    <td style="padding:10px 0;border-top:1px solid #e3e8ec"><b style="color:#0f1f2b">${esc(f.title)}</b>${f.done ? ` <span style="color:#1f8a4c">✓ ${T('done', 'تم')}</span>` : ''}<br><span style="color:#3d4f5c">${esc(f.act)}</span>${f.impact ? `<br><span style="color:#0a6c86;font-weight:600">${esc(f.impact)}</span>` : ''}</td></tr>`).join('');
  const title = mode === 'followup' ? T('How are your OptiROAS actions going?', 'كيف يسير تنفيذ إجراءات OptiROAS؟') : T('Your OptiROAS audit report', 'تقرير تدقيق OptiROAS الخاص بك');
  const intro = mode === 'followup'
    ? T(`A week ago you saved an audit${d.label ? ` for ${d.label}` : ''}. You've marked ${done.length} of ${d.findings.length} actions as done. Here's what's still open.`, `قبل أسبوع حفظت تدقيقًا${d.label ? ` لـ ${d.label}` : ''}. علّمت ${done.length} من ${d.findings.length} إجراءات كمنفّذة. هذه الإجراءات التي لم تُنفَّذ بعد.`)
    : T(`${d.label ? d.label + ' · ' : ''}${d.period}. Health score ${d.score}/100 · ad spend ${money(d.total, d.cur)} · est. inefficient spend ${money(d.waste, d.cur)}/month.`, `${d.label ? d.label + ' · ' : ''}${d.period}. درجة الصحة ${d.score}/100 · الإنفاق ${money(d.total, d.cur)} · إنفاق غير فعّال تقديري ${money(d.waste, d.cur)} شهريًا.`);
  const html = `<!doctype html><html lang="${d.lang}" dir="${dir}"><body style="margin:0;background:#f4f7f9;font-family:Segoe UI,Arial,sans-serif;color:#0f1f2b">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;padding:28px;text-align:${al}">
<tr><td style="font-size:22px;font-weight:800">Opti<span style="color:#0a6c86">ROAS</span></td></tr>
<tr><td style="padding-top:18px;font-size:19px;font-weight:700">${esc(title)}</td></tr>
<tr><td style="padding:8px 0 14px;font-size:14px;line-height:1.6;color:#3d4f5c">${esc(intro)}</td></tr>
<tr><td><table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.5">${rows || `<tr><td>${esc(T('Every action is marked done. Nice work.', 'كل الإجراءات منفّذة. أحسنت.'))}</td></tr>`}</table></td></tr>
<tr><td style="padding:20px 0 6px"><a href="${esc(link)}" style="background:#0a6c86;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700;display:inline-block">${esc(id ? T('Open and update progress', 'افتح التقرير وحدّث التقدم') : T('Open OptiROAS', 'افتح OptiROAS'))}</a></td></tr>
<tr><td style="padding-top:14px;font-size:12.5px;color:#6b7c88;line-height:1.6">${esc(T('Estimates are based on the files you audited and are not financial advice. Starter and Pro plans connect your ad accounts and email a fresh audit every Monday, so you don’t need to export files again.', 'التقديرات مبنية على الملفات التي دقّقتها وليست نصيحة مالية. تربط خطتا Starter وPro حساباتك الإعلانية وترسل تدقيقًا جديدًا كل يوم اثنين، دون الحاجة إلى تصدير الملفات مجددًا.'))}${mode === 'followup' ? `<br>${esc(T('You got this because you asked for a 7-day follow-up. It is sent once.', 'وصلتك هذه الرسالة لأنك طلبت متابعة بعد 7 أيام. تُرسل مرة واحدة.'))}` : ''}</td></tr>
</table><p style="font-size:12px;color:#8a99a4">OptiROAS · admin@optiroas.com</p></td></tr></table></body></html>`;
  const text = `${title}\n\n${intro}\n\n` + list.slice(0, 25).map((f, i) => `${i + 1}. ${f.title}${f.done ? ' (done)' : ''}\n   ${f.act}${f.impact ? `\n   ${f.impact}` : ''}`).join('\n\n') + `\n\n${link}`;
  return { subject: title, html, text };
}
