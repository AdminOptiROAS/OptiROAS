import { currentUser, sql, json, body, ensureSchema } from './_lib/core.js';

// Records a few product events and page views for the owner's daily summary. Only known names are stored.
const EVENTS = new Set(['checkout_start', 'paywall_open']);
const PAGES = new Set(['start', 'home', 'workspace', 'how', 'delivered', 'pillars', 'calculator', 'platforms', 'pricing', 'faq', 'audit',
  'privacy', 'terms', 'welcome', 'data-deletion', 'account', 'signin', 'reset']);
const clean = (v, n) => String(v || '').replace(/[^\w.\-]/g, '').slice(0, n) || null;
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const b = body(req);
  const ev = String(b.ev || '');
  if (ev === 'pv') {
    const page = String(b.p || '');
    if (!PAGES.has(page)) return json(res, 400, { error: 'Unknown page' });
    const secs = Math.max(0, Math.min(1800, Math.round(Number(b.s) || 0)));
    const n = b.n ? 1 : 0;
    if (!n && !secs) return json(res, 200, { ok: true });
    await ensureSchema();
    const user = await currentUser(req).catch(() => null);
    await sql`insert into page_views(vid, user_id, page, n, secs, src) values(${clean(b.v, 40)}, ${user ? user.id : null}, ${page}, ${n}, ${secs}, ${clean(b.src, 60)})`;
    return json(res, 200, { ok: true });
  }
  if (!EVENTS.has(ev)) return json(res, 400, { error: 'Unknown event' });
  await ensureSchema();
  const user = await currentUser(req).catch(() => null);
  await sql`insert into site_events(user_id, ev) values(${user ? user.id : null}, ${ev})`;
  return json(res, 200, { ok: true });
}
