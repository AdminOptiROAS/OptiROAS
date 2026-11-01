import crypto from 'node:crypto';
import { currentUser, cookies, setCookie, sql, json, encrypt, decrypt, ensureSchema, logApi } from '../_lib/core.js';
import { sallaMode, sallaReady, canConnectStore, sallaToken, sallaUserInfo, saveConnection, sallaOrdersCsv, sallaVerify, expiry, SALLA_AUTH } from '../_lib/salla.js';

// /api/salla/start | callback | webhook | status | orders | disconnect  (one function for the whole Salla connection)
const go = (res, to) => { res.statusCode = 302; res.setHeader('Location', to); res.end(); };
const back = (res, q) => go(res, `/?${q}#account`);
async function raw(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks).toString('utf8');
}
const day = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null;

// An install that arrived by webhook (Easy mode) is linked to the user who asked to connect:
// the same email on both sides, or the only person who clicked Connect in the last 30 minutes.
async function linkInstall(merchantId) {
  const i = (await sql`select * from salla_installs where merchant_id=${merchantId}`)[0];
  if (!i) return null;
  let u = i.email ? (await sql`select p.user_id from salla_pending p join users u on u.id=p.user_id where lower(u.email)=${i.email} and p.at > now() - interval '2 hours'`)[0] : null;
  if (!u) {
    // no email match: only link when there is exactly one person waiting and exactly one new install, so a store can never land in the wrong account
    const p = await sql`select user_id from salla_pending where at > now() - interval '30 minutes'`;
    const n = (await sql`select count(*)::int as n from salla_installs where created_at > now() - interval '30 minutes'`)[0].n;
    if (p.length === 1 && n === 1) u = p[0];
  }
  if (!u) return null;
  await saveConnection(u.user_id, { access_token: decrypt(i.access_enc), refresh_token: i.refresh_enc ? decrypt(i.refresh_enc) : null, expires: Math.floor(new Date(i.expires_at) / 1000), scope: i.scope },
    { merchantId: i.merchant_id, storeName: i.store_name, domain: i.store_domain, email: i.email });
  return u.user_id;
}

export default async function handler(req, res) {
  const action = String((req.query && req.query.action) || new URL(req.url, 'https://x').pathname.split('/').pop());
  await ensureSchema();

  if (action === 'webhook') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
    const payload = await raw(req);
    if (!sallaVerify(payload, req.headers)) return json(res, 401, { error: 'Bad signature' });
    let ev; try { ev = JSON.parse(payload); } catch { return json(res, 400, { error: 'Bad JSON' }); }
    const merchantId = String(ev.merchant || (ev.data && ev.data.merchant) || '');
    if (ev.event === 'app.store.authorize' && merchantId && ev.data && ev.data.access_token) {
      const d = ev.data;
      let info = { merchantId, storeName: null, domain: null, email: null };
      try { info = { ...info, ...(await sallaUserInfo(d.access_token)), merchantId }; } catch (e) { console.error('salla userinfo', e.message); }
      const linked = (await sql`select user_id from salla_connections where merchant_id=${merchantId}`)[0];
      if (linked) await saveConnection(linked.user_id, d, info);   // token renewal after an app update: keep the same user
      else {
        await sql`insert into salla_installs(merchant_id, store_name, store_domain, email, access_enc, refresh_enc, expires_at, scope)
          values(${merchantId}, ${info.storeName}, ${info.domain}, ${info.email}, ${encrypt(d.access_token)}, ${d.refresh_token ? encrypt(d.refresh_token) : null}, ${expiry(d.expires)}, ${d.scope || null})
          on conflict(merchant_id) do update set store_name=excluded.store_name, store_domain=excluded.store_domain, email=excluded.email, access_enc=excluded.access_enc,
            refresh_enc=excluded.refresh_enc, expires_at=excluded.expires_at, scope=excluded.scope, created_at=now()`;
        await linkInstall(merchantId);
      }
    } else if (/uninstall/.test(String(ev.event)) && merchantId) {
      await sql`delete from salla_connections where merchant_id=${merchantId}`;
      await sql`delete from salla_installs where merchant_id=${merchantId}`;
    }
    return json(res, 200, { received: true });
  }

  const user = await currentUser(req);

  if (action === 'start') {
    if (!user) return back(res, 'salla=signin');
    if (!canConnectStore(user)) return go(res, '/?upgrade=connect#pricing');
    if (!sallaReady()) return back(res, 'salla=error&why=' + encodeURIComponent('The Salla connection is not set up yet.'));
    if (sallaMode() === 'easy') {
      await sql`insert into salla_pending(user_id, at) values(${user.id}, now()) on conflict(user_id) do update set at=now()`;
      return go(res, `https://s.salla.sa/apps/install/${encodeURIComponent(process.env.SALLA_APP_ID)}`);
    }
    const state = crypto.randomBytes(24).toString('base64url');
    setCookie(res, 'or_sa_state', `${state}.${user.id}`, 600);
    const u = new URL(`${SALLA_AUTH}/auth`);
    u.search = new URLSearchParams({ client_id: process.env.SALLA_CLIENT_ID, response_type: 'code', redirect_uri: process.env.SALLA_REDIRECT_URI, scope: 'offline_access', state }).toString();
    return go(res, u.toString());
  }

  if (action === 'callback') {
    const p = Object.fromEntries(new URL(req.url, 'https://optiroas.com').searchParams);
    const [state, uid] = String(cookies(req).or_sa_state || '').split('.');
    setCookie(res, 'or_sa_state', '', 0);
    if (!user) return back(res, 'salla=signin');
    if (p.error) return back(res, 'salla=cancelled');
    if (!p.code || p.state !== state || uid !== user.id) return back(res, 'salla=error&why=state');
    try {
      const tok = await sallaToken({ grant_type: 'authorization_code', code: p.code, redirect_uri: process.env.SALLA_REDIRECT_URI, scope: 'offline_access' });
      const info = await sallaUserInfo(tok.access_token);
      await logApi(user.id, 'salla:userinfo', true);
      if (!info.merchantId) throw new Error('Salla did not say which store this is. Please connect again.');
      await saveConnection(user.id, tok, info);
      return back(res, 'salla=connected');
    } catch (e) {
      console.error('salla callback', e.message);
      await logApi(user.id, 'salla:token', false, String(e.message).slice(0, 200));
      return back(res, 'salla=error&why=' + encodeURIComponent(String(e.message).slice(0, 160)));
    }
  }

  if (!user) return json(res, 401, { error: 'Sign in first.' });

  if (action === 'status') {
    // Easy mode: the install may have arrived before we knew who it belonged to; try again now that this user is asking
    let c = (await sql`select store_name, store_domain, connected_at, last_import_at from salla_connections where user_id=${user.id}`)[0];
    if (!c && sallaMode() === 'easy') {
      const mine = await sql`select merchant_id from salla_installs where lower(email)=${String(user.email).toLowerCase()} and created_at > now() - interval '2 days'`;
      if (mine[0]) { await sql`insert into salla_pending(user_id, at) values(${user.id}, now()) on conflict(user_id) do update set at=now()`; await linkInstall(mine[0].merchant_id); }
      c = (await sql`select store_name, store_domain, connected_at, last_import_at from salla_connections where user_id=${user.id}`)[0];
    }
    return json(res, 200, { available: sallaReady(), allowed: canConnectStore(user), mode: sallaMode(),
      connected: !!c, store: c ? c.store_name : null, domain: c ? c.store_domain : null, since: c ? c.connected_at : null, lastImport: c ? c.last_import_at : null });
  }

  if (action === 'orders') {
    if (!canConnectStore(user)) return json(res, 403, { error: 'Store connections come with Starter and Pro.', code: 'plan' });
    const q = Object.fromEntries(new URL(req.url, 'https://x').searchParams);
    const to = day(q.to) || new Date().toISOString().slice(0, 10);
    const from = day(q.from) || new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    if (from > to || (new Date(to) - new Date(from)) / 864e5 > 400) return json(res, 400, { error: 'Pick a date range of up to 13 months.' });
    try { return json(res, 200, { ok: true, from, to, ...(await sallaOrdersCsv(user.id, from, to)) }); }
    catch (e) { return json(res, e.code === 'not_connected' ? 404 : e.code === 'reconnect' || e.status === 401 ? 409 : 502, { error: e.message, code: e.code || (e.status === 401 ? 'reconnect' : 'salla') }); }
  }

  if (action === 'disconnect') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
    await sql`delete from salla_connections where user_id=${user.id}`;
    await sql`delete from salla_pending where user_id=${user.id}`;
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Not found' });
}
