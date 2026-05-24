import { stackServerApp } from '@/stack';
import { NextResponse, type NextRequest } from 'next/server';

const PROTECTED_PREFIXES = ['/watchlist', '/stock', '/api'];
const PUBLIC_API_PREFIXES = ['/api/health', '/api/cron', '/api/fallback'];

export async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;

  if (pathname.startsWith('/handler')) return NextResponse.next();

  if (PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const needsAuth = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  if (!needsAuth) return NextResponse.next();

  const user = await stackServerApp.getUser({ tokenStore: req });
  if (user) return NextResponse.next();

  if (pathname.startsWith('/api')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const signIn = new URL('/handler/signin', req.nextUrl);
  signIn.searchParams.set('after_auth_return_to', pathname);
  return NextResponse.redirect(signIn);
}

export const config = {
  matcher: ['/((?!_next/|favicon|.*\\..*).*)']
};
