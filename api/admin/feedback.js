import { currentUser, sql, json } from '../_lib/core.js';
import { isAdmin } from '../_lib/plan.js';

// Team only (ADMIN_EMAILS): all feedback as a CSV that opens in Excel or Google Sheets.
export default async function handler(req, res) {
  const user = await currentUser(req);
  if (!user || !isAdmin(user)) return json(res, 403, { error: 'Team accounts only.' });
  const rows = await sql`select created_at,rating,message,email,page,lang from feedback order by created_at desc limit 10000`;
  const cell = v => { const s = v == null ? '' : String(v instanceof Date ? v.toISOString() : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = '﻿' + [['Date (UTC)', 'Rating', 'Message', 'Email', 'Page', 'Language'].join(',')].concat(rows.map(r => [r.created_at, r.rating, r.message, r.email, r.page, r.lang].map(cell).join(','))).join('\n');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="optiroas-feedback-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(csv);
}
