import crypto from 'node:crypto';
import { sql, sha } from './core.js';
import { sendMail, layout, SITE } from './mail.js';

// Single-use email tokens: 'reset' (1 hour) and 'verify' (3 days). Only the SHA-256 hash is stored.
export async function issueToken(userId, kind) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = kind === 'reset' ? '1 hour' : '3 days';
  await sql`update user_tokens set used_at=now() where user_id=${userId} and kind=${kind} and used_at is null`;
  await sql`insert into user_tokens(token_hash,user_id,kind,expires_at) values(${sha(token)},${userId},${kind},now()+${ttl}::interval)`;
  return token;
}
export async function useToken(token, kind) {
  const r = await sql`update user_tokens set used_at=now() where token_hash=${sha(String(token || ''))} and kind=${kind}
    and used_at is null and expires_at>now() returning user_id`;
  return r[0] ? r[0].user_id : null;
}
export async function recentTokens(userId, kind) {
  return (await sql`select count(*)::int as n from user_tokens where user_id=${userId} and kind=${kind} and created_at>now()-interval '1 hour'`)[0].n;
}
export async function sendVerify(user, lang) {
  const t = await issueToken(user.id, 'verify'), link = `${SITE()}/api/auth/verify?token=${t}`;
  const ar = lang === 'ar';
  return sendMail({ to: user.email, subject: ar ? 'أكّد بريدك الإلكتروني لـ OptiROAS' : 'Confirm your email for OptiROAS', ...layout({ lang, link,
    title: ar ? 'أكّد بريدك الإلكتروني' : 'Confirm your email',
    intro: ar ? 'اضغط الزر لتأكيد بريدك وتفعيل تدقيقك المجاني.' : 'Click the button to confirm your email and unlock your free audit.',
    button: ar ? 'تأكيد البريد' : 'Confirm email',
    outro: ar ? 'ينتهي هذا الرابط بعد 3 أيام. إذا لم تنشئ حسابًا في OptiROAS، تجاهل هذه الرسالة.' : 'This link expires in 3 days. If you didn’t create an OptiROAS account, you can ignore this email.' }) });
}
export async function sendReset(user, lang) {
  const t = await issueToken(user.id, 'reset'), link = `${SITE()}/reset?token=${t}`;
  const ar = lang === 'ar';
  return sendMail({ to: user.email, subject: ar ? 'إعادة تعيين كلمة مرور OptiROAS' : 'Reset your OptiROAS password', ...layout({ lang, link,
    title: ar ? 'إعادة تعيين كلمة المرور' : 'Reset your password',
    intro: ar ? 'طلب أحدهم إعادة تعيين كلمة مرور حسابك في OptiROAS. اضغط الزر لاختيار كلمة مرور جديدة.' : 'Someone asked to reset the password for your OptiROAS account. Click the button to choose a new one.',
    button: ar ? 'اختر كلمة مرور جديدة' : 'Choose a new password',
    outro: ar ? 'ينتهي هذا الرابط بعد ساعة ويعمل مرة واحدة. إذا لم تطلب ذلك، تجاهل الرسالة وستبقى كلمة مرورك كما هي.' : 'This link expires in 1 hour and works once. If you didn’t ask for this, ignore this email and your password stays the same.' }) });
}
