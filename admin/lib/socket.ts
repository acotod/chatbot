'use client';
import { io, Socket } from 'socket.io-client';
import { getStoredAccessToken } from '@/store/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3200';

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
