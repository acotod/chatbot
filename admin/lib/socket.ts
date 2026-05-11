'use client';
import { io, Socket } from 'socket.io-client';
import { getStoredAccessToken } from '@/store/auth';

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
}

function parseHostname(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

function resolveSocketBase(): string {
  const envBase = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (envBase) {
    if (typeof window !== 'undefined') {
      const currentHost = window.location.hostname;
      const envHost = parseHostname(envBase);
      if (!(envHost && isLocalHostname(envHost) && !isLocalHostname(currentHost))) {
        return envBase.replace(/\/+$/, '');
      }
    } else {
      return envBase.replace(/\/+$/, '');
    }
  }

  if (typeof window !== 'undefined') {
    const { hostname, origin, port, protocol } = window.location;
    if (isLocalHostname(hostname)) {
      return 'http://127.0.0.1:3001';
    }
    if (hostname.startsWith('admin.')) {
      return `${protocol}//api.${hostname.slice('admin.'.length)}${port ? `:${port}` : ''}`;
    }
    return origin;
  }

  return 'http://127.0.0.1:3001';
}

const API_URL = resolveSocketBase();

let socket: Socket | null = null;
let activeTenantId: string | null = null;

export function getSocket(tenantId: string): Socket {
  const token = typeof window !== 'undefined' ? (getStoredAccessToken() ?? '') : '';

  if (socket && activeTenantId !== tenantId) {
    socket.disconnect();
    socket = null;
    activeTenantId = null;
  }

  if (!socket) {
    socket = io(API_URL, {
      auth: { token },
      query: { tenantId },
      transports: ['websocket'],
      autoConnect: true,
    });
    activeTenantId = tenantId;
  }
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
  activeTenantId = null;
}
