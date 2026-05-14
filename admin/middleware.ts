import createIntlMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { locales, defaultLocale } from './lib/i18n/config';

const intlMiddleware = createIntlMiddleware({
  locales,
  defaultLocale,
  localePrefix: 'as-needed',
});

export function middleware(request: NextRequest) {
  const host = request.headers.get('host') || '';
  let pathname = request.nextUrl.pathname;
  
  // Strip locale prefix for path-based checks (e.g. /en/agente/login → /agente/login)
  const localePattern = new RegExp(`^/(${locales.join('|')})(\/|$)`);
  const pathnameWithoutLocale = pathname.replace(localePattern, '/');

  // Check if this is an agent-specific domain
  const isAgentDomain = host.includes('agente');
  
  // Routes that should redirect to agent routes when accessed from agent domain
  if (isAgentDomain) {
    // /login → /agente/login
    if (pathnameWithoutLocale === '/login' || pathnameWithoutLocale.startsWith('/login/')) {
      return NextResponse.redirect(new URL(`/agente/login${pathnameWithoutLocale === '/login' ? '' : pathnameWithoutLocale.replace('/login', '')}`, request.url));
    }
    
    // /portal → /agente (agent portal)
    if (pathnameWithoutLocale === '/portal' || pathnameWithoutLocale.startsWith('/portal/')) {
      return NextResponse.redirect(new URL(`/agente${pathnameWithoutLocale.replace('/portal', '')}`, request.url));
    }
    
    // Protect agent routes: if accessing /agente from agent domain, allow it.
    // Allow auth API paths so login requests don't get redirected.
    // Otherwise, route to /agente/login for non-public pages.
    if (
      !pathnameWithoutLocale.startsWith('/agente') &&
      !pathnameWithoutLocale.startsWith('/facebook') &&
      !pathnameWithoutLocale.startsWith('/_next') &&
      !pathnameWithoutLocale.startsWith('/auth')
    ) {
      // This is an admin-only route accessed from agent domain, redirect to agent login
      return NextResponse.redirect(new URL('/agente/login', request.url));
    }
  } else {
    // Non-agent domains: ensure /agente routes go to agent login
    if (pathnameWithoutLocale.startsWith('/agente/') && !pathnameWithoutLocale.startsWith('/agente/login') && !pathnameWithoutLocale.startsWith('/agente/register')) {
      // Accessing agent-protected routes from admin domain without auth
      return NextResponse.redirect(new URL('/login', request.url));
    }
  }
  
  // Apply i18n middleware
  return intlMiddleware(request);
}

export const config = {
  // Protect everything except Next.js internals and static assets
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$).*)'],
};
