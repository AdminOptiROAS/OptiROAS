// Shared helpers for campaign pickers.
export const STATUS = s => { s = String(s || '').toUpperCase();
  if (/^(ACTIVE|ENABLED|ENABLE|CAMPAIGN_STATUS_ENABLE|STATUS_DELIVERY_OK|STATUS_ENABLE)$/.test(s)) return 'active';
  if (/PAUSE|DISABLE/.test(s)) return 'paused';
  if (/DELETE|REMOVE|ARCHIV/.test(s)) return 'removed';
  return s ? 'other' : 'other'; };
export const idsParam = q => String(q.get('campaigns') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 500);
export const range = days => { const until = new Date(Date.now() - 864e5), since = new Date(until.getTime() - (days - 1) * 864e5);
  return { since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) }; };
export const daysParam = q => Math.min(90, Math.max(7, parseInt(q.get('days') || '60', 10) || 60));
