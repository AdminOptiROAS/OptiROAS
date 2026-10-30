import { currentUser, sql, json, body, ensureSchema } from './_lib/core.js';

// Records a few product events for the owner's daily summary. Only known event names are stored.
const EVENTS = new Set(['checkout_start', 'paywall_open']);
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  const ev = String(body(req).ev || '');
  if (!EVENTS.has(ev)) return json(res, 400, { error: 'Unknown event' });
  await ensureSchema();
  const user = await currentUser(req).catch(() => null);
  await sql`insert into site_events(user_id, ev) values(${user ? user.id : null}, ${ev})`;
  return json(res, 200, { ok: true });
}
