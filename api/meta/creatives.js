import { currentUser, sql, json, metaToken, graph, appSecretProof } from '../_lib/core.js';
import { idsParam, daysParam, range } from '../_lib/camps.js';
import { canConnect } from '../_lib/plan.js';

// Creative details for the ads in a connected Meta account: preview image, format, copy, Meta's own
// quality / engagement / conversion rankings and video hook and hold counts, for the period audited.
// Read-only. Images are Meta's own short-lived preview links; nothing is stored.
const FIRST = (list, k) => { const a = (list || []).find(x => x.action_type === k); return a ? +a.value || 0 : 0; };
const format = c => {
  if (!c) return 'Other';
  if (c.asset_feed_spec) return 'Flexible';
  if (c.product_set_id) return 'Catalog';
  const ld = c.object_story_spec && c.object_story_spec.link_data;
  if (ld && Array.isArray(ld.child_attachments) && ld.child_attachments.length > 1) return 'Carousel';
  if (c.video_id || (c.object_story_spec && c.object_story_spec.video_data)) return 'Video';
  if (c.image_url || c.image_hash || (ld && (ld.image_hash || ld.picture))) return 'Image';
  return String(c.object_type || 'Other').replace(/_/g, ' ').toLowerCase().replace(/^./, m => m.toUpperCase());
};

export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Sign in first.' });
  if (!canConnect(user)) return json(res, 402, { error: 'Connecting ad accounts is part of Starter and Pro. Upgrade to connect.', code: 'upgrade' });
  const q = new URL(req.url, 'https://optiroas.com').searchParams;
  const account = String(q.get('account') || '');
  const own = await sql`select account_id from meta_ad_accounts where user_id=${user.id} and account_id=${account}`;
  if (!own[0]) return json(res, 404, { error: 'That ad account isn’t connected to your OptiROAS account.' });
  const token = await metaToken(user.id);
  if (!token) return json(res, 409, { error: 'Connect Meta first.' });
  const ids = idsParam(q), proof = appSecretProof(token);
  try {
    // one row per ad for the whole period (rankings need the aggregate, not daily rows)
    const rows = [];
    let page = await graph(`/${account}/insights`, {
      level: 'ad', limit: 500, time_range: range(daysParam(q)),
      fields: 'ad_id,ad_name,campaign_name,spend,impressions,actions,video_thruplay_watched_actions,quality_ranking,engagement_rate_ranking,conversion_rate_ranking',
      ...(ids.length ? { filtering: [{ field: 'campaign.id', operator: 'IN', value: ids }] } : {}),
      access_token: token, appsecret_proof: proof
    }, { userId: user.id });
    for (let i = 0; page && i < 20; i++) { rows.push(...(page.data || [])); const n = page.paging && page.paging.next; page = n ? await graph(n, {}, { userId: user.id }) : null; }
    rows.sort((a, b) => (+b.spend || 0) - (+a.spend || 0));
    const top = rows.slice(0, 150), meta = {};
    for (let i = 0; i < top.length; i += 50) {
      const batch = top.slice(i, i + 50).map(x => x.ad_id).join(',');
      const C = '{thumbnail_url,image_url,image_hash,video_id,object_type,title,body,call_to_action_type,product_set_id,asset_feed_spec{videos{video_id},images{hash}},object_story_spec{video_data{video_id},link_data{image_hash,picture,child_attachments{name}}}}';
      let r = {};
      // larger previews first; fall back to Meta's default size, then to no creative details at all
      for (const f of ['creative.thumbnail_width(480).thumbnail_height(480)' + C, 'creative' + C, 'creative{thumbnail_url,video_id,object_type}']) {
        try { r = await graph('/', { ids: batch, fields: 'created_time,effective_status,' + f, access_token: token, appsecret_proof: proof }, { userId: user.id }); break; } catch (e) { r = {}; }
      }
      Object.assign(meta, r);
    }
    const RK = v => (!v || v === 'UNKNOWN') ? null : v;
    const ads = top.map(x => {
      const m = meta[x.ad_id] || {}, c = m.creative || {};
      return { id: x.ad_id, name: x.ad_name, camp: x.campaign_name, spend: +x.spend || 0, impr: +x.impressions || 0,
        v3: FIRST(x.actions, 'video_view'), thru: FIRST(x.video_thruplay_watched_actions, 'video_view'),
        quality: RK(x.quality_ranking), engagement: RK(x.engagement_rate_ranking), conversion: RK(x.conversion_rate_ranking),
        format: format(c), thumb: c.thumbnail_url || c.image_url || null, title: (c.title || '').slice(0, 120), body: (c.body || '').slice(0, 280),
        cta: c.call_to_action_type || null, created: m.created_time || null, status: m.effective_status || null };
    });
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, { ads });
  } catch (e) {
    const expired = e.meta && (e.meta.code === 190 || e.meta.type === 'OAuthException');
    return json(res, expired ? 409 : 502, { error: expired ? 'Your Meta connection has expired. Reconnect Meta.' : `Meta: ${e.message}` });
  }
}
