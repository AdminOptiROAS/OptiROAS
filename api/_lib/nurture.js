import crypto from 'node:crypto';
import { sql } from './core.js';
import { sendMail, layout, SITE } from './mail.js';

// Follow-up emails after sign-up, for people who haven't subscribed yet. Sent by the daily cron (09:00 UAE):
//   step 1 – day 1, step 2 – day 3, step 3 – day 7 (last). The wording depends on whether they have run an audit yet.
// Stops as soon as they subscribe or unsubscribe. Team, reviewer and allowlisted test accounts never get them.
const SERIES_START = process.env.NURTURE_START || '2026-11-10'; // accounts created before this never get the series
const STEPS = [{ step: 1, after: '20 hours' }, { step: 2, after: '3 days' }, { step: 3, after: '7 days' }];

export const unsubSig = id => crypto.createHmac('sha256', process.env.ENCRYPTION_KEY || 'optiroas').update('mkt:' + id).digest('base64url').slice(0, 22);
export const unsubLink = id => `${SITE()}/api/leads?uu=${id}.${unsubSig(id)}`;

const link = (lang, path, step) => `${SITE()}/${path}${path.includes('?') ? '&' : '?'}lang=${lang}&utm_source=email&utm_medium=email&utm_campaign=onboarding_${step}`;

export function nurtureEmail(step, lang, ranAudit, id) {
  const ar = lang === 'ar';
  const T = (en, a) => (ar ? a : en);
  let m;
  if (step === 1 && !ranAudit) m = {
    subject: T('Your first OptiROAS audit takes 5 minutes', 'تدقيقك الأول على OptiROAS يأخذ 5 دقائق'),
    title: T('Ready for your first audit?', 'جاهز لتدقيقك الأول؟'),
    intro: T('Download your campaign report from Meta, Google Ads, TikTok or Snapchat and upload it. In a few minutes you’ll see your account health score and your top 3 fixes, free.',
      'نزّل تقرير حملاتك من Meta أو Google Ads أو TikTok أو Snapchat وارفعه. خلال دقائق سترى درجة صحة حسابك وأهم 3 إصلاحات، مجانًا.'),
    paras: [[T('Not sure which file to download? Each platform has a short step-by-step guide.', 'لست متأكدًا أي ملف تنزّل؟ لكل منصة دليل قصير خطوة بخطوة.'), link(lang, 'platforms', 1), T('Open the export guides', 'افتح أدلة التصدير')],
      [T('Want to see what you’ll get first?', 'تريد أن ترى النتيجة أولًا؟'), link(lang, '?example=1', 1), T('Open the example report', 'افتح التقرير النموذجي')]],
    button: T('Run my audit', 'شغّل تدقيقي'), url: link(lang, '', 1) + '#audit'
  };
  else if (step === 1) m = {
    subject: T('Your full audit is one step away', 'تدقيقك الكامل على بُعد خطوة'),
    title: T('You’ve seen your score. Here’s the rest.', 'رأيت درجتك. إليك الباقي.'),
    intro: T('Your full audit shows every finding with the evidence from your own data, the exact steps to fix it, and how much each one is worth per month.',
      'يعرض تدقيقك الكامل كل ملاحظة مع الدليل من بياناتك، وخطوات الإصلاح بالتحديد، وقيمة كل منها شهريًا.'),
    paras: [T('The Audit plan is AED 55 a month for 3 full audits. Cancel any time.', 'خطة التدقيق بـ 55 درهمًا شهريًا وتشمل 3 تدقيقات كاملة. يمكنك الإلغاء في أي وقت.')],
    button: T('Unlock my full audit', 'افتح تدقيقي الكامل'), url: link(lang, 'pricing', 1)
  };
  else if (step === 2 && !ranAudit) m = {
    subject: T('Need a hand with your ad exports?', 'تحتاج مساعدة في تنزيل ملفات إعلاناتك؟'),
    title: T('Stuck on the export? We’ll help.', 'متوقف عند التصدير؟ سنساعدك.'),
    intro: T('Most people get stuck finding the right report to download. Reply to this email with the platform you advertise on and we’ll send you the exact steps.',
      'أغلب الناس يتوقفون عند إيجاد التقرير الصحيح لتنزيله. ردّ على هذا البريد باسم المنصة التي تعلن عليها وسنرسل لك الخطوات بالتحديد.'),
    paras: [T('Or follow the guide for your platform; it takes about 2 minutes.', 'أو اتبع دليل منصتك؛ يأخذ نحو دقيقتين.')],
    button: T('Open the export guides', 'افتح أدلة التصدير'), url: link(lang, 'platforms', 2)
  };
  else if (step === 2) m = {
    subject: T('What your top fixes could be worth', 'كم تساوي إصلاحاتك الأهم؟'),
    title: T('Where is your ad spend leaking?', 'أين يتسرّب إنفاقك الإعلاني؟'),
    intro: T('Advertisers usually find spend going to campaigns below break-even, audiences that overlap and search terms that never sell. Your full audit puts an AED figure on each one, so you know where to start.',
      'عادةً يجد المعلنون إنفاقًا يذهب إلى حملات تحت نقطة التعادل، وجماهير متداخلة، وعبارات بحث لا تبيع أبدًا. تدقيقك الكامل يضع مبلغًا بالدرهم على كل منها لتعرف من أين تبدأ.'),
    paras: [T('AED 55 a month, 3 full audits, cancel any time.', '55 درهمًا شهريًا، 3 تدقيقات كاملة، والإلغاء في أي وقت.')],
    button: T('See my full audit', 'شاهد تدقيقي الكامل'), url: link(lang, 'pricing', 2)
  };
  else m = {
    subject: T('Last reminder: your OptiROAS audit', 'تذكير أخير: تدقيقك على OptiROAS'),
    title: T('One audit usually pays for itself', 'تدقيق واحد عادةً يغطي تكلفته'),
    intro: T('If you’re spending on Meta, Google, TikTok or Snapchat ads, the fixes in one audit are usually worth more than the AED 55 it costs. 3 full audits a month, cancel any time.',
      'إذا كنت تنفق على إعلانات Meta أو Google أو TikTok أو Snapchat، فقيمة الإصلاحات في تدقيق واحد غالبًا أكبر من 55 درهمًا. 3 تدقيقات كاملة شهريًا، والإلغاء في أي وقت.'),
    paras: [T('Questions first? Just reply to this email.', 'لديك أسئلة؟ ردّ على هذا البريد فقط.')],
    button: ranAudit ? T('Unlock my full audit', 'افتح تدقيقي الكامل') : T('Run my audit', 'شغّل تدقيقي'),
    url: ranAudit ? link(lang, 'pricing', 3) : link(lang, '', 3) + '#audit'
  };
  const outro = step === 3
    ? T('This is our last reminder. You can still sign in any time at optiroas.com.', 'هذا آخر تذكير منا. يمكنك تسجيل الدخول في أي وقت على optiroas.com.')
    : T('You’re getting this because you created an OptiROAS account. Reply any time; a person reads every email.', 'تصلك هذه الرسالة لأنك أنشأت حسابًا على OptiROAS. ردّ في أي وقت؛ يقرأ كل رسالة شخص من فريقنا.');
  const unsub = unsubLink(id);
  return { subject: m.subject, ...layout({ lang: ar ? 'ar' : 'en', title: m.title, intro: m.intro, paras: m.paras, button: m.button, link: m.url, outro, unsub }) };
}

export async function runNurture(limit = 100) {
  const skip = [process.env.ADMIN_EMAILS, process.env.REVIEW_EMAILS, process.env.ALLOWED_EMAILS].join(',').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  let sent = 0, checked = 0;
  for (const { step, after } of STEPS) {
    const due = await sql`select u.id, u.email, u.lang, exists(select 1 from usage_reports r where r.user_id=u.id) as ran
      from users u where u.created_at >= ${SERIES_START}::timestamptz and u.created_at <= now() - ${after}::interval
        and u.nurture_step = ${step - 1} and (u.nurture_at is null or u.nurture_at < now() - interval '40 hours')
        and u.mkt_unsub_at is null and coalesce(u.plan,'free') not in ('audit','starter','pro') and coalesce(u.audit_credits,0) = 0
        and lower(u.email) <> all(${skip}) order by u.created_at limit ${limit}`;
    for (const u of due) {
      checked++;
      // claim the step first so a retried cron run can never send the same email twice
      const claim = await sql`update users set nurture_step=${step}, nurture_at=now() where id=${u.id} and nurture_step=${step - 1} returning id`;
      if (!claim[0]) continue;
      const ok = await sendMail({ to: u.email, ...nurtureEmail(step, u.lang === 'ar' ? 'ar' : 'en', u.ran, u.id) });
      if (ok) sent++; else await sql`update users set nurture_step=${step - 1}, nurture_at=null where id=${u.id}`;
    }
  }
  return { checked, sent };
}
