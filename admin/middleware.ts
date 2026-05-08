import { NextRequest, NextResponse } from 'next/server';

function getTokenExpMs(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;

    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = JSON.parse(atob(padded)) as { exp?: number };

    if (typeof decoded.exp !== 'number') return null;
    return decoded.exp * 1000;
  } catch {
    return null;
  }
}

export function middleware(request: NextRequest) {
  const token = request.cookies.get('admin_token')?.value;
  const agentToken = request.cookies.get('agent_token')?.value;
  const { pathname } = request.nextUrl;
  const isLoginPath = pathname.startsWith('/login');
  const isPortalPath = pathname.startsWith('/portal');
  const isAgentPath = pathname.startsWith('/agente');
  const isAgentLoginPath = pathname.startsWith('/agente/login');

  if (isAgentPath) {
    if (agentToken) {
      const expMs = getTokenExpMs(agentToken);
      if (expMs && Date.now() >= expMs) {
        const response = NextResponse.redirect(new URL('/agente/login?reason=expired', request.url));
        response.cookies.delete('agent_token');
        return response;
      }
    }

    if (agentToken && isAgentLoginPath) {
      return NextResponse.redirect(new URL('/agente/perfil', request.url));
    }

    if (!agentToken && !isAgentLoginPath) {
      return NextResponse.redirect(new URL('/agente/login', request.url));
    }

    return NextResponse.next();
  }

  if (token) {
    const expMs = getTokenExpMs(token);
    if (expMs && Date.now() >= expMs) {
      const response = NextResponse.redirect(new URL('/login?reason=expired', request.url));
      response.cookies.delete('admin_token');
      return response;
    }
  }

  // Already at login — redirect to dashboard if authenticated
  if (token && isLoginPath) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  // No token and trying to access a protected route — send to login
  if (!token && !isLoginPath && !isPortalPath) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Protect everything except Next.js internals and static assets
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$).*)'],
};
