import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const host = request.headers.get('host') || '';
  const pathname = request.nextUrl.pathname;
  
  // Check if this is an agent-specific domain
  const isAgentDomain = host.includes('agente');
  
  // Routes that should redirect to agent routes when accessed from agent domain
  if (isAgentDomain) {
    // /login → /agente/login
    if (pathname === '/login' || pathname.startsWith('/login/')) {
      return NextResponse.redirect(new URL(`/agente/login${pathname === '/login' ? '' : pathname.replace('/login', '')}`, request.url));
    }
    
    // /portal → /agente (agent portal)
    if (pathname === '/portal' || pathname.startsWith('/portal/')) {
      return NextResponse.redirect(new URL(`/agente${pathname.replace('/portal', '')}`, request.url));
    }
    
    // Protect agent routes: if accessing /agente from agent domain, allow it.
    // Allow auth API paths so login requests don't get redirected.
    // Otherwise, route to /agente/login for non-public pages.
    if (
      !pathname.startsWith('/agente') &&
      !pathname.startsWith('/facebook') &&
      !pathname.startsWith('/_next') &&
      !pathname.startsWith('/auth')
    ) {
      // This is an admin-only route accessed from agent domain, redirect to agent login
      return NextResponse.redirect(new URL('/agente/login', request.url));
    }
  } else {
    // Non-agent domains: ensure /agente routes go to agent login
    if (pathname.startsWith('/agente/') && !pathname.startsWith('/agente/login') && !pathname.startsWith('/agente/register')) {
      // Accessing agent-protected routes from admin domain without auth
      return NextResponse.redirect(new URL('/login', request.url));
    }
  }
  
  return NextResponse.next();
}

export const config = {
  // Protect everything except Next.js internals and static assets
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$).*)'],
};
