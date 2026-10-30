import crypto from 'node:crypto';
import { ensureSchema, sql, json } from '../_lib/core.js';

// Stripe → OptiROAS plan sync. Verifies the Stripe-Signature header with STRIPE_WEBHOOK_SECRET.
// checkout.session.completed links the Stripe customer to the user (client_reference_id, else email);
// customer.subscription.* sets the plan from the subscribed product, and back to free when it ends.
// Audit plan (AED 55/month, 3 full audits per billing period): its period comes from the subscription events.
// A paid one-time checkout (mode=payment) adds one audit credit to the user.
const PRODUCTS = () => ({
  [process.env.STRIPE_PRODUCT_STARTER || 'prod_VUKZcFyMlsFRoN']: 'starter',
  [process.env.STRIPE_PRODUCT_PRO || 'prod_VUKZ5k8FivEwsL']: 'pro',
  [process.env.STRIPE_PRODUCT_AUDIT || 'prod_VXJClD7uvpwsMN']: 'audit'
});
// Payment link for the Audit plan (AED 55 a month), so checkout can set the plan before the subscription event arrives
const AUDIT_LINK = () => process.env.STRIPE_LINK_AUDIT || 'plink_1UWEbV2cgkqFH4LbYq4pbDFY';
const ts = s => (s ? new Date(s * 1000) : null);
const LIVE = new Set(['active', 'trialing', 'past_due']);

async function raw(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks).toString('utf8');
}
function verify(payload, header, secret) {
  const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=')).filter(p => p.length === 2 && p[0] !== 'v1'));
  const sigs = String(header || '').split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const t = +parts.t; if (!t || Math.abs(Date.now() / 1000 - t) > 300 || !sigs.length) return false;
  const want = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return sigs.some(s => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json(res, 500, { error: 'Webhook not configured' });
  const payload = await raw(req);
  if (!verify(payload, req.headers['stripe-signature'], secret)) return json(res, 400, { error: 'Bad signature' });
  const ev = JSON.parse(payload), o = ev.data && ev.data.object || {};
  await ensureSchema();
  if (ev.type === 'checkout.session.completed' && o.mode === 'payment' && o.payment_status === 'paid') {
    // $14.99 single audit: one credit per paid checkout, counted once even if Stripe retries the event
    const email = String(o.customer_details && o.customer_details.email || o.customer_email || '').toLowerCase();
    const ref = /^[0-9a-f-]{36}$/i.test(o.client_reference_id || '') ? o.client_reference_id : null;
    const u = ref ? await sql`select id from users where id=${ref}` : await sql`select id from users where email=${email}`;
    if (!u[0]) { console.error('stripe webhook: no OptiROAS user for audit payment', o.id); return json(res, 200, { received: true }); }
    const ins = await sql`insert into audit_payments(session_id, user_id, amount) values(${o.id}, ${u[0].id}, ${o.amount_total || 0}) on conflict do nothing returning session_id`;
    if (ins.length) await sql`update users set audit_credits = audit_credits + 1 where id=${u[0].id}`;
  } else if (ev.type === 'checkout.session.completed' && o.mode === 'subscription') {
    const email = String(o.customer_details && o.customer_details.email || o.customer_email || '').toLowerCase();
    const ref = /^[0-9a-f-]{36}$/i.test(o.client_reference_id || '') ? o.client_reference_id : null;
    const u = ref ? await sql`select id from users where id=${ref}` : await sql`select id from users where email=${email}`;
    const audit = o.payment_link === AUDIT_LINK();
    if (u[0] && audit) await sql`update users set stripe_customer_id=${o.customer}, plan=case when plan in ('free','audit') then 'audit' else plan end,
        period_start=coalesce(period_start, now()), period_end=coalesce(period_end, now() + interval '1 month') where id=${u[0].id}`;
    else if (u[0]) await sql`update users set stripe_customer_id=${o.customer}, plan=case when plan in ('free','audit') then 'paid' else plan end where id=${u[0].id}`;
    else console.error('stripe webhook: no OptiROAS user for checkout', o.id);
  } else if (/^customer\.subscription\.(created|updated|deleted)$/.test(ev.type)) {
    const prod = o.items && o.items.data && o.items.data[0] && o.items.data[0].price && o.items.data[0].price.product;
    const plan = ev.type.endsWith('deleted') || !LIVE.has(o.status) ? 'free' : (PRODUCTS()[prod] || 'paid');
    const it = o.items && o.items.data && o.items.data[0] || {};
    const ps = ts(o.current_period_start || it.current_period_start), pe = ts(o.current_period_end || it.current_period_end);
    const r = await sql`update users set plan=${plan}, period_start=coalesce(${ps}, period_start), period_end=coalesce(${pe}, period_end) where stripe_customer_id=${o.customer} returning id`;
    if (!r.length) console.error('stripe webhook: no user yet for customer', o.customer, ev.type);
  }
  return json(res, 200, { received: true });
}
