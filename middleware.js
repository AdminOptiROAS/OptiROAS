import { rewrite, next } from '@vercel/functions';

// kiteoai.com is the same app under the Kiteo brand: serve kiteo.html (Kiteo title, description and preview image) there.
export const config = { matcher: ['/', '/((?!api/|media/|_vercel|.*\\.).*)'] };
export default function middleware(request) {
  const host = (request.headers.get('host') || new URL(request.url).hostname).toLowerCase();
  if (!/(^|\.)kiteoai\.com(:\d+)?$/.test(host)) return next();
  const url = new URL(request.url);
  return rewrite(new URL('/kiteo.html' + url.search, request.url));
}
