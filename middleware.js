// kiteoai.com is the same app under the Kiteo brand: serve kiteo.html (Kiteo title, description and preview image) there.
export const config = { matcher: ['/', '/((?!api/|media/|_vercel|.*\\.).*)'] };
export default function middleware(request) {
  const url = new URL(request.url);
  if (!/(^|\.)kiteoai\.com$/i.test(url.hostname)) return;
  return new Response(null, { headers: { 'x-middleware-rewrite': new URL('/kiteo.html' + url.search, url).toString() } });
}
