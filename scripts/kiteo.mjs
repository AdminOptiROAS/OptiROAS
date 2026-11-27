// Run before each commit (git pre-commit hook): writes kiteo.html, the same app as index.html but with Kiteo's title, description and preview image
// in the HTML itself (so link previews and search engines see Kiteo). middleware.js serves it on kiteoai.com.
import fs from 'node:fs';
let s = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const rep = (re, to) => { if (!re.test(s)) throw new Error('kiteo build: pattern not found ' + re); s = s.replace(re, to); };
const T = 'Kiteo: make AI recommend your brand';
const D = 'Kiteo shows whether ChatGPT, Gemini, Perplexity and Claude recommend your brand, what they say about you, and how to rise above competitors. Built for Saudi Arabia and the GCC, in Arabic and English.';
rep(/<html lang="en">/, '<html lang="en" data-brand="kiteo">');
rep(/<title>[^<]*<\/title>/, `<title>${T}</title>`);
rep(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${D}">`);
rep(/<meta property="og:site_name" content="[^"]*">/, '<meta property="og:site_name" content="Kiteo">');
rep(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${T}">`);
rep(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${D}">`);
rep(/<meta property="og:url" content="[^"]*">/, '<meta property="og:url" content="https://www.kiteoai.com/">');
rep(/<meta property="og:image" content="[^"]*">/, '<meta property="og:image" content="https://www.kiteoai.com/kiteo-og.png">');
rep(/<link rel="icon" href="[^"]*">/, `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230a1f5c'/%3E%3Cpath d='M32 10 50 30 32 50 14 30Z' fill='%233d6bff'/%3E%3Cpath d='M32 50c-2 4 2 6 0 10' stroke='%23ffc83d' stroke-width='3' fill='none'/%3E%3C/svg%3E">`);
rep(/<a class="btn sm navcta" href="#audit">Start free<\/a>/, '<a class="btn sm navcta" href="#kbook">Book a free check</a>');
// Google: kiteoai.com uses its own Tag Manager container instead of OptiROAS's Google Ads / GA4 tag (one Google tag per page).
rep(/<!-- Google tag \(gtag\.js\) -->[\s\S]*?<\/script>\s*<script>[\s\S]*?<\/script>/, `<!-- Google tag (Kiteo: GTM-WZQ88VNH) -->
<script async src="https://www.googletagmanager.com/gtm.js?id=GTM-WZQ88VNH"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
</script>`);
// Meta: kiteoai.com reports to the Kiteo pixel, not OptiROAS's (head snippet, noscript image and the in-page events).
rep(/29179497201735288/g, '29394428376884505');
// Snapchat: kiteoai.com reports to the Kiteo Snap pixel, not OptiROAS's (base code and the in-page events).
rep(/70531021-0759-43b3-af5b-6367514d7f14/g, 'daa4eed4-98ce-4871-b232-16d4e296bde0');
fs.writeFileSync(new URL('../kiteo.html', import.meta.url), s);
console.log('kiteo.html written', s.length);
