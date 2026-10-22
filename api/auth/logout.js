import { ensureSchema, json, endSession } from '../_lib/core.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
  await ensureSchema();
  await endSession(req, res);
  return json(res, 200, { ok: true });
}
