'use client';
import { io, Socket } from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3200';

let socket: Socket | null = null;

export function getSocket(tenantId: string): Socket {
  if (!socket) {
    const token =
      typeof window !== 'undefined'
        ? (localStorage.getItem('admin_token') ?? '')
        : '';
    socket = io(API_URL, {
      auth: { token },
      query: { tenantId },
      transports: ['websocket'],
      autoConnect: true,
    });
  }
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
