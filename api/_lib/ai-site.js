// Website check: what a brand's site is missing for AI assistants to find, read, trust and recommend it.
// Rule-based (no AI calls): fetches the homepage, robots.txt, sitemap, llms.txt and a few inner pages.
import { sql } from './core.js';

const UA = 'Mozilla/5.0 (compatible; KiteoBot/1.0; +https://www.kiteoai.com)';
// The crawlers that feed the assistants we track (plus the search indexes they rely on).
export const AI_BOTS = [
  ['GPTBot', 'ChatGPT (training)'], ['OAI-SearchBot', 'ChatGPT search'], ['ChatGPT-User', 'ChatGPT browsing'],
  ['PerplexityBot', 'Perplexity'], ['ClaudeBot', 'Claude'], ['Claude-SearchBot', 'Claude search'],
  ['Google-Extended', 'Gemini'], ['Googlebot', 'Google Search'], ['Bingbot', 'Bing (used by ChatGPT and others)'], ['Applebot-Extended', 'Apple Intelligence']
];
const SEARCH_BOTS = new Set(['OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Claude-SearchBot', 'Googlebot', 'Bingbot']);

async function get(url, ua = UA, ms = 15000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(ms), headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml,text/plain,*/*' } });
    const text = (await r.text()).slice(0, 2_000_000);
    return { ok: r.ok, status: r.status, url: r.url || url, text, ms: Date.now() - t0, type: r.headers.get('content-type') || '' };
  } catch (e) { return { ok: false, status: 0, url, text: '', ms: Date.now() - t0, error: String(e.message || e) }; }
}

// robots.txt: is "/" disallowed for this user agent? (longest-match on the group for the agent, else "*")
export function robotsBlocks(txt, agent) {
  const groups = []; let cur = null, lastUA = false;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!lastUA) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastUA = true; }
    else { lastUA = false; if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push([k, v]); }
  }
  const a = agent.toLowerCase();
  const g = groups.filter(x => x.agents.some(n => n !== '*' && a.startsWith(n))).concat([]);
  const use = g.length ? g : groups.filter(x => x.agents.includes('*'));
  let best = null;
  for (const grp of use) for (const [k, v] of grp.rules) {
    if (k === 'disallow' && !v) continue;
    const pat = v.replace(/\*/g, '');
    if ('/'.startsWith(pat) || pat === '/' ) if (!best || pat.length > best[1].length || (pat.length === best[1].length && k === 'allow')) best = [k, pat];
  }
  return !!best && best[0] === 'disallow';
}

const textOf = h => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const attr = (tag, name) => { const m = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null; };
const metas = h => [...String(h).matchAll(/<meta\b[^>]*>/gi)].map(m => m[0]);
const meta = (h, key) => { const t = metas(h).find(x => (attr(x, 'name') || attr(x, 'property') || '').toLowerCase() === key); return t ? attr(t, 'content') : null; };

// every schema.org @type in the page's JSON-LD (flattening @graph and nested objects)
export function schemaTypes(html) {
  const types = new Map(); let sameAs = 0, bad = 0;
  const walk = o => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    const t = o['@type']; (Array.isArray(t) ? t : t ? [t] : []).forEach(x => { const k = String(x); const a = types.get(k) || []; a.push(o); types.set(k, a); });
    if (o.sameAs) sameAs = Math.max(sameAs, Array.isArray(o.sameAs) ? o.sameAs.length : 1);
    Object.values(o).forEach(v => typeof v === 'object' && walk(v));
  };
  for (const m of String(html).matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch { bad++; }
  }
  // microdata fallback
  for (const m of String(html).matchAll(/itemtype\s*=\s*["']https?:\/\/schema\.org\/([A-Za-z]+)["']/gi)) if (!types.has(m[1])) types.set(m[1], [{}]);
  return { types, sameAs, bad };
}
const has = (T, ...names) => names.some(n => T.types.has(n));

function sitemapUrls(xml) { return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1].replace(/&amp;/g, '&')); }

// Each check: id, status pass|warn|fail, impact high|medium|low, en/ar label, detail, fix.
export async function siteCheck(website, { country = 'SA' } = {}) {
  const host = String(website || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (!host || !/\./.test(host)) return { error: 'no_website' };
  const C = [], add = (c) => C.push(c);
  let home = await get(`https://${host}/`);
  if (!home.ok && !home.text) home = await get(`https://www.${host.replace(/^www\./, '')}/`);
  const base = (() => { try { return new URL(home.url).origin; } catch { return `https://${host}`; } })();

  // 1. reachable
  if (!home.ok) {
    add({ id: 'reach', group: 'access', status: 'fail', impact: 'high', en: 'Your website could not be opened', ar: 'تعذّر فتح موقعك',
      detail: home.status ? `HTTP ${home.status}` : (home.error || ''), fixEn: 'Make sure your homepage opens publicly over https, without a login or a country block.', fixAr: 'تأكد أن صفحتك الرئيسية تفتح للجميع عبر https، بدون تسجيل دخول أو حجب حسب الدولة.' });
    return finish(C, host, base, home);
  }
  const H = home.text, words = textOf(H).split(' ').filter(Boolean);
  add({ id: 'https', group: 'access', status: /^https:/.test(home.url) ? 'pass' : 'fail', impact: 'medium', en: 'Secure (https) website', ar: 'موقع آمن (https)',
    fixEn: 'Serve the whole site over https.', fixAr: 'اجعل الموقع كله يعمل عبر https.' });
  add({ id: 'speed', group: 'access', status: home.ms < 1500 ? 'pass' : home.ms < 4000 ? 'warn' : 'fail', impact: 'low', en: 'Homepage loads quickly', ar: 'الصفحة الرئيسية تفتح بسرعة',
    detail: `${(home.ms / 1000).toFixed(1)}s`, fixEn: 'Speed up the homepage (image sizes, hosting, caching). Slow pages are crawled less.', fixAr: 'سرّع الصفحة الرئيسية (أحجام الصور، الاستضافة، التخزين المؤقت). الصفحات البطيئة تُزار أقل.' });

  // 2. AI crawlers: robots.txt + firewall
  const rob = await get(`${base}/robots.txt`, UA, 10000);
  const robTxt = rob.ok && /text\/plain|octet|^$/i.test(rob.type) && !/<html/i.test(rob.text) ? rob.text : '';
  const blocked = AI_BOTS.filter(([b]) => robTxt && robotsBlocks(robTxt, b));
  const blockedSearch = blocked.filter(([b]) => SEARCH_BOTS.has(b));
  add({ id: 'robots', group: 'access', status: blockedSearch.length ? 'fail' : blocked.length ? 'warn' : 'pass', impact: 'high',
    en: 'AI assistants are allowed to read your site', ar: 'مساعدات الذكاء الاصطناعي مسموح لها بقراءة موقعك',
    detail: blocked.length ? `Blocked in robots.txt: ${blocked.map(b => `${b[0]} (${b[1]})`).join(', ')}` : (robTxt ? 'robots.txt allows them' : 'No robots.txt (everything allowed)'),
    detailAr: blocked.length ? `محجوب في robots.txt: ${blocked.map(b => b[0]).join('، ')}` : '',
    fixEn: `Remove the "Disallow" rules for ${blocked.map(b => b[0]).join(', ') || 'AI crawlers'} in robots.txt. If an assistant can't read your site, it can't recommend it or link to it.`,
    fixAr: `احذف قواعد "Disallow" الخاصة بـ ${blocked.map(b => b[0]).join('، ') || 'زواحف الذكاء الاصطناعي'} في ملف robots.txt. إذا لم يستطع المساعد قراءة موقعك فلن يرشّحه أو يضع رابطه.` });
  const fw = [];
  for (const [ua, name] of [['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)', 'ChatGPT'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)', 'Perplexity'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'Claude']]) {
    const r = await get(`${base}/`, ua, 12000); if (!r.ok || /captcha|cf-challenge|attention required|access denied/i.test(r.text.slice(0, 5000))) fw.push(`${name}${r.status ? ` (HTTP ${r.status})` : ''}`);
  }
  add({ id: 'firewall', group: 'access', status: fw.length ? 'fail' : 'pass', impact: 'high', en: 'Your firewall lets AI crawlers in', ar: 'جدار الحماية يسمح لزواحف الذكاء الاصطناعي بالدخول',
    detail: fw.length ? `Blocked or challenged: ${fw.join(', ')}` : '', detailAr: fw.length ? `محجوب أو مطلوب تحقق: ${fw.join('، ')}` : '',
    fixEn: 'Your hosting or firewall (often Cloudflare "Block AI bots" or bot protection) is turning AI crawlers away. Allow GPTBot, OAI-SearchBot, PerplexityBot, ClaudeBot and Claude-SearchBot.',
    fixAr: 'الاستضافة أو جدار الحماية (غالبًا خيار Cloudflare «Block AI bots» أو حماية البوتات) يمنع زواحف الذكاء الاصطناعي. اسمح لـ GPTBot وOAI-SearchBot وPerplexityBot وClaudeBot وClaude-SearchBot.' });

  // 3. sitemap + llms.txt
  const smUrl = (robTxt.match(/^\s*sitemap\s*:\s*(\S+)/im) || [])[1] || `${base}/sitemap.xml`;
  const sm = await get(smUrl, UA, 12000);
  let urls = sm.ok ? sitemapUrls(sm.text) : [];
  if (urls.length && urls.every(u => /\.xml(\?|$)/i.test(u))) { const sub = await get(urls.find(u => /product/i.test(u)) || urls[0], UA, 12000); urls = sub.ok ? sitemapUrls(sub.text) : []; }
  add({ id: 'sitemap', group: 'access', status: urls.length ? 'pass' : 'warn', impact: 'medium', en: 'Sitemap lists your pages', ar: 'خريطة الموقع (sitemap) تعرض صفحاتك',
    detail: urls.length ? `${urls.length}${urls.length >= 50000 ? '+' : ''} pages` : '', fixEn: 'Publish /sitemap.xml with all your product and category pages, and link it from robots.txt.', fixAr: 'انشر ملف ‎/sitemap.xml‎ يضم كل صفحات المنتجات والأقسام، وأضف رابطه في robots.txt.' });
  const llms = await get(`${base}/llms.txt`, UA, 8000);
  add({ id: 'llms', group: 'access', status: llms.ok && !/<html/i.test(llms.text.slice(0, 500)) && llms.text.trim().length > 30 ? 'pass' : 'warn', impact: 'low', en: 'llms.txt guide for AI', ar: 'ملف llms.txt لإرشاد الذكاء الاصطناعي',
    fixEn: 'Add /llms.txt: a short plain-text summary of your brand, best-selling products, prices, delivery areas and key pages. Some assistants read it.', fixAr: 'أضف ملف ‎/llms.txt‎: ملخص نصي قصير عن علامتك ومنتجاتك الأكثر مبيعًا والأسعار ومناطق التوصيل والصفحات المهمة. بعض المساعدات تقرؤه.' });

  // 4. content readable without JavaScript
  add({ id: 'text', group: 'content', status: words.length >= 250 ? 'pass' : words.length >= 80 ? 'warn' : 'fail', impact: 'high', en: 'Your pages have readable text (not only JavaScript)', ar: 'صفحاتك فيها نص مقروء (ليست JavaScript فقط)',
    detail: `${words.length} words on the homepage`, detailAr: `${words.length} كلمة في الصفحة الرئيسية`,
    fixEn: 'Most AI crawlers don\'t run JavaScript. Make sure product names, descriptions and prices are in the page HTML (server-side rendering), and add a short text intro on the homepage about what you sell.',
    fixAr: 'معظم زواحف الذكاء الاصطناعي لا تشغّل JavaScript. تأكد أن أسماء المنتجات وأوصافها وأسعارها موجودة في HTML الصفحة، وأضف مقدمة نصية قصيرة في الرئيسية عمّا تبيعه.' });
  const noindex = /noindex/i.test(meta(H, 'robots') || '');
  if (noindex) add({ id: 'noindex', group: 'access', status: 'fail', impact: 'high', en: 'Homepage is hidden from search (noindex)', ar: 'الصفحة الرئيسية مخفية عن البحث (noindex)',
    fixEn: 'Remove the "noindex" robots meta tag from your homepage.', fixAr: 'احذف وسم noindex من الصفحة الرئيسية.' });
  const title = (H.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1], desc = meta(H, 'description');
  add({ id: 'title', group: 'content', status: title && desc ? 'pass' : title || desc ? 'warn' : 'fail', impact: 'medium', en: 'Clear page title and description', ar: 'عنوان ووصف واضحان للصفحة',
    detail: title ? `“${textOf(title).slice(0, 80)}”` : '', fixEn: 'Give every page a title and meta description that say what you sell and where, e.g. "Oud perfumes in Riyadh | Brand".', fixAr: 'اجعل لكل صفحة عنوانًا ووصفًا يوضحان ما تبيعه وأين، مثل «عطور عود في الرياض | العلامة».' });
  const ar = (textOf(H).match(/[؀-ۿ]/g) || []).length, hasArPage = /hreflang\s*=\s*["']?ar/i.test(H) || /\/ar(\/|["'?])/i.test(H) || /lang\s*=\s*["']?ar/i.test(H);
  if (['SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'EG'].includes(country)) add({ id: 'arabic', group: 'content', status: ar > 200 || hasArPage ? 'pass' : 'fail', impact: 'high', en: 'Arabic version of your site', ar: 'نسخة عربية من موقعك',
    fixEn: 'Shoppers in the Gulf ask AI in Arabic. Publish Arabic pages (with hreflang="ar") for your products, not just English.', fixAr: 'المتسوقون في الخليج يسألون الذكاء الاصطناعي بالعربية. انشر صفحات عربية لمنتجاتك (مع hreflang="ar")، لا الإنجليزية فقط.' });
  const T = schemaTypes(H);
  const org = has(T, 'Organization', 'Corporation', 'LocalBusiness', 'Store', 'OnlineStore', 'Brand', 'ClothingStore', 'HealthAndBeautyBusiness', 'Restaurant', 'MedicalBusiness');
  add({ id: 'org', group: 'trust', status: org ? (T.sameAs >= 2 ? 'pass' : 'warn') : 'fail', impact: 'high', en: 'Brand details in structured data (Organization)', ar: 'بيانات العلامة المنظّمة (Organization)',
    detail: org ? (T.sameAs >= 2 ? `${T.sameAs} social profiles linked` : 'No social profiles linked (sameAs)') : '', detailAr: org && T.sameAs < 2 ? 'لا توجد روابط لحساباتك الاجتماعية (sameAs)' : '',
    fixEn: 'Add Organization schema (JSON-LD) on the homepage: official name in Arabic and English, logo, phone, address, and "sameAs" links to Instagram, TikTok, Snapchat, Noon and Amazon stores. This is how AI connects facts to your brand.',
    fixAr: 'أضف بيانات Organization (JSON-LD) في الرئيسية: الاسم الرسمي بالعربية والإنجليزية، الشعار، الهاتف، العنوان، وروابط sameAs لحساباتك في Instagram وTikTok وSnapchat ومتاجرك في نون وأمازون. هكذا يربط الذكاء الاصطناعي المعلومات بعلامتك.' });
  add({ id: 'website', group: 'trust', status: has(T, 'WebSite') ? 'pass' : 'warn', impact: 'low', en: 'Site name in structured data (WebSite)', ar: 'اسم الموقع في البيانات المنظّمة (WebSite)',
    fixEn: 'Add WebSite schema with your brand name so search engines show the right name.', fixAr: 'أضف بيانات WebSite باسم علامتك ليظهر الاسم الصحيح في البحث.' });

  // 5. inner pages: products (price, availability, ratings) and FAQ
  const inner = urls.filter(u => { try { return new URL(u).origin === base || new URL(u).hostname.replace(/^www\./, '') === host.replace(/^www\./, ''); } catch { return false; } });
  const prodUrls = inner.filter(u => /\/(products?|p|item|shop|store|منتج)\//i.test(u)).slice(0, 3);
  const linked = [...H.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)].map(m => { try { return new URL(m[1], base).href; } catch { return null; } }).filter(u => u && u.startsWith(base));
  const pick = (prodUrls.length ? prodUrls : linked.filter(u => /\/(products?|p|item|collections?|shop)\//i.test(u)).slice(0, 3));
  const pages = []; for (const u of pick.slice(0, 3)) { const r = await get(u, UA, 12000); if (r.ok) pages.push(r); }
  const PT = pages.map(p => schemaTypes(p.text));
  const prod = PT.filter(t => has(t, 'Product', 'ProductGroup')), withOffer = prod.filter(t => (t.types.get('Product') || t.types.get('ProductGroup') || []).some(p => p.offers || p.hasVariant) || t.types.has('Offer') || t.types.has('AggregateOffer'));
  const rated = [T, ...PT].some(t => has(t, 'AggregateRating', 'Review'));
  if (pages.length) {
    add({ id: 'product', group: 'content', status: withOffer.length === pages.length ? 'pass' : prod.length ? 'warn' : 'fail', impact: 'high', en: 'Product pages have price and stock in structured data', ar: 'صفحات المنتجات فيها السعر والتوفر كبيانات منظّمة',
      detail: `${withOffer.length} of ${pages.length} product pages checked`, detailAr: `${withOffer.length} من ${pages.length} صفحات منتجات`,
      fixEn: 'Add Product schema to every product page with name, brand, image, price in SAR/AED, availability and SKU. Assistants quote prices and stock from this.', fixAr: 'أضف بيانات Product لكل صفحة منتج: الاسم، العلامة، الصورة، السعر بالريال/الدرهم، التوفر، ورمز المنتج. المساعدات تنقل الأسعار والتوفر منها.' });
  } else add({ id: 'product', group: 'content', status: has(T, 'Product', 'ItemList', 'OfferCatalog') ? 'pass' : 'warn', impact: 'medium', en: 'Products described in structured data', ar: 'المنتجات موصوفة كبيانات منظّمة',
    detail: 'No product pages found to check', detailAr: 'لم نجد صفحات منتجات لفحصها', fixEn: 'Add Product schema (name, price, availability) to your product or service pages.', fixAr: 'أضف بيانات Product (الاسم، السعر، التوفر) لصفحات منتجاتك أو خدماتك.' });
  add({ id: 'ratings', group: 'trust', status: rated ? 'pass' : 'warn', impact: 'medium', en: 'Ratings and reviews shown on your site', ar: 'التقييمات والمراجعات ظاهرة في موقعك',
    fixEn: 'Show customer reviews on product pages and mark them up with AggregateRating schema. AI favours products with visible, recent reviews.', fixAr: 'اعرض تقييمات العملاء في صفحات المنتجات وأضف لها بيانات AggregateRating. الذكاء الاصطناعي يفضّل المنتجات ذات التقييمات الظاهرة والحديثة.' });
  const allHtml = [H, ...pages.map(p => p.text)].join(' ');
  const faq = [T, ...PT].some(t => has(t, 'FAQPage')) || /(faq|frequently asked|الأسئلة الشائعة|أسئلة شائعة)/i.test(allHtml);
  add({ id: 'faq', group: 'content', status: faq ? 'pass' : 'warn', impact: 'medium', en: 'Answers to common customer questions (FAQ)', ar: 'إجابات أسئلة العملاء الشائعة (FAQ)',
    fixEn: 'Add an FAQ page (Arabic and English) answering the exact questions shoppers ask AI: best product for X, price, delivery time, returns, authenticity. Mark it up with FAQPage schema.', fixAr: 'أضف صفحة أسئلة شائعة (بالعربية والإنجليزية) تجيب عن الأسئلة نفسها التي يطرحها المتسوقون على الذكاء الاصطناعي: أفضل منتج لـ…، السعر، مدة التوصيل، الإرجاع، الأصالة. وأضف لها بيانات FAQPage.' });
  const contact = /(tel:|wa\.me|whatsapp|\+?9(66|71|65|74|73|68)[\s\d-]{7,})/i.test(allHtml);
  add({ id: 'contact', group: 'trust', status: contact ? 'pass' : 'warn', impact: 'medium', en: 'Phone or WhatsApp visible', ar: 'رقم الهاتف أو واتساب ظاهر',
    fixEn: 'Show a local phone or WhatsApp number and your city on every page (footer). It signals a real, local business.', fixAr: 'اعرض رقمًا محليًا أو واتساب ومدينتك في كل صفحة (التذييل). هذا يدل على نشاط تجاري حقيقي ومحلي.' });
  const about = /href\s*=\s*["'][^"']*(about|our-story|who-we-are|من-نحن|about-us)[^"']*["']/i.test(H) || /(من نحن|about us)/i.test(textOf(H));
  add({ id: 'about', group: 'trust', status: about ? 'pass' : 'warn', impact: 'medium', en: 'About page with your story', ar: 'صفحة «من نحن» بقصتك',
    fixEn: 'Publish an About page: founding year, founders, where products are made or sourced, certifications and awards. Assistants use it to describe your brand.', fixAr: 'انشر صفحة «من نحن»: سنة التأسيس، المؤسسون، مكان الصنع أو المصدر، الشهادات والجوائز. المساعدات تعتمد عليها لوصف علامتك.' });
  const price = /(SAR|AED|KWD|QAR|BHD|OMR|EGP|ر\.?\s?س|ريال|درهم|د\.إ|﷼)\s?\d|\d[\d,.]*\s?(SAR|AED|KWD|QAR|ر\.?\s?س|ريال|درهم)/i.test(textOf(allHtml));
  add({ id: 'prices', group: 'content', status: price ? 'pass' : 'warn', impact: 'medium', en: 'Prices visible in the page text', ar: 'الأسعار ظاهرة في نص الصفحة',
    fixEn: 'Show prices in local currency as text (not only in images or after clicking). Shoppers ask AI for prices; if it can\'t find yours it quotes a competitor\'s.', fixAr: 'اعرض الأسعار بالعملة المحلية كنص (لا في الصور فقط أو بعد النقر). المتسوقون يسألون الذكاء الاصطناعي عن الأسعار، وإذا لم يجد سعرك ذكر سعر منافس.' });
  const imgs = [...H.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]), noAlt = imgs.filter(t => !(attr(t, 'alt') || '').trim()).length;
  if (imgs.length >= 3) add({ id: 'alt', group: 'content', status: noAlt / imgs.length <= 0.2 ? 'pass' : 'warn', impact: 'low', en: 'Images have descriptions (alt text)', ar: 'الصور لها أوصاف (alt)',
    detail: `${noAlt} of ${imgs.length} images without alt text`, detailAr: `${noAlt} من ${imgs.length} صور بدون وصف`, fixEn: 'Describe product images with alt text (product name, colour, size) in the page language.', fixAr: 'صِف صور المنتجات بنص alt (اسم المنتج، اللون، المقاس) بلغة الصفحة.' });
  const og = meta(H, 'og:title') && meta(H, 'og:image');
  add({ id: 'og', group: 'content', status: og ? 'pass' : 'warn', impact: 'low', en: 'Share previews (Open Graph)', ar: 'معاينات المشاركة (Open Graph)',
    fixEn: 'Add og:title, og:description and og:image so links to your site show your brand when shared and cited.', fixAr: 'أضف og:title وog:description وog:image لتظهر علامتك عند مشاركة روابط موقعك أو الاستشهاد بها.' });
  return finish(C, host, base, home, { blocked: blocked.map(b => b[0]), pages: pages.map(p => p.url), schema: [...T.types.keys()].slice(0, 20) });
}

const W = { high: 3, medium: 2, low: 1 }, S = { pass: 1, warn: 0.5, fail: 0 };
// how each check reads when it isn't passing
const PROB = {
  reach: ['Your website could not be opened', 'تعذّر فتح موقعك'], https: ['Your site isn’t fully secure (https)', 'موقعك ليس آمنًا بالكامل (https)'],
  speed: ['Your homepage is slow to load', 'صفحتك الرئيسية بطيئة'], robots: ['AI assistants are blocked in robots.txt', 'مساعدات الذكاء الاصطناعي محجوبة في robots.txt'],
  firewall: ['Your firewall blocks AI crawlers', 'جدار الحماية يحجب زواحف الذكاء الاصطناعي'], sitemap: ['No sitemap listing your pages', 'لا توجد خريطة موقع (sitemap) لصفحاتك'],
  llms: ['No llms.txt guide for AI', 'لا يوجد ملف llms.txt لإرشاد الذكاء الاصطناعي'], text: ['Too little readable text for AI', 'النص المقروء للذكاء الاصطناعي قليل جدًا'],
  noindex: ['Homepage is hidden from search (noindex)', 'الصفحة الرئيسية مخفية عن البحث (noindex)'], title: ['Page title or description missing', 'عنوان الصفحة أو وصفها مفقود'],
  arabic: ['No Arabic version of your site', 'لا توجد نسخة عربية من موقعك'], org: ['Brand details missing from structured data', 'بيانات العلامة المنظّمة ناقصة'],
  website: ['Site name missing from structured data', 'اسم الموقع غير موجود في البيانات المنظّمة'], product: ['Product prices and stock aren’t in structured data', 'أسعار المنتجات وتوفرها ليست في البيانات المنظّمة'],
  ratings: ['No ratings or reviews on your site', 'لا توجد تقييمات أو مراجعات في موقعك'], faq: ['No FAQ answering customer questions', 'لا توجد أسئلة شائعة تجيب عن أسئلة العملاء'],
  contact: ['No phone or WhatsApp visible', 'لا يظهر رقم هاتف أو واتساب'], about: ['No About page with your story', 'لا توجد صفحة «من نحن»'],
  prices: ['Prices aren’t visible as text', 'الأسعار غير ظاهرة كنص'], alt: ['Many images have no description (alt text)', 'صور كثيرة بلا وصف (alt)'], og: ['No share previews (Open Graph)', 'لا توجد معاينات للمشاركة (Open Graph)']
};
function finish(C, host, base, home, extra = {}) {
  const tot = C.reduce((a, c) => a + W[c.impact], 0), got = C.reduce((a, c) => a + W[c.impact] * S[c.status], 0);
  C.forEach(c => { if (c.status !== 'pass' && PROB[c.id]) { c.probEn = PROB[c.id][0]; c.probAr = PROB[c.id][1]; } });
  const order = { fail: 0, warn: 1, pass: 2 };
  C.sort((a, b) => order[a.status] - order[b.status] || W[b.impact] - W[a.impact]);
  return { host, url: base, status: home.status, score: tot ? Math.round(100 * got / tot) : 0, checks: C, ...extra, at: new Date().toISOString() };
}

export async function ensureSite() {
  await sql`create table if not exists ai_site(user_id uuid primary key references users(id) on delete cascade, website text, score int, result jsonb, checked_at timestamptz not null default now())`;
}
export async function runSiteCheck(userId) {
  await ensureSite();
  const b = (await sql`select website, country from ai_brands where user_id=${userId}`)[0];
  if (!b || !b.website) return null;
  const r = await siteCheck(b.website, { country: b.country });
  if (r.error) return r;
  const prev = (await sql`select score from ai_site where user_id=${userId}`)[0];
  r.prevScore = prev ? prev.score : null;
  await sql`insert into ai_site(user_id, website, score, result, checked_at) values(${userId}, ${b.website}, ${r.score}, ${JSON.stringify(r)}, now())
    on conflict(user_id) do update set website=excluded.website, score=excluded.score, result=excluded.result, checked_at=now()`;
  return r;
}
export async function siteState(userId) {
  await ensureSite();
  const r = (await sql`select website, score, result, checked_at from ai_site where user_id=${userId}`)[0];
  return r ? { ...r.result, website: r.website, checkedAt: r.checked_at } : null;
}
