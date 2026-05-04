'use client';
import { useEffect, useCallback, useRef } from 'react';
import { getSocket } from '@/lib/socket';
import { useQueryClient } from '@tanstack/react-query';

type EventCallback = (data: unknown) => void;

/** Generic single-event hook */
export function useSocket(tenantId: string | null, event: string, callback: EventCallback) {
  const stableCallback = useCallback(callback, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!tenantId) return;
    const s = getSocket(tenantId);
    s.on(event, stableCallback);
    return () => {
      s.off(event, stableCallback);
    };
  }, [tenantId, event, stableCallback]);
}

/** Socket connection status */
export function useSocketStatus(tenantId: string | null): 'connected' | 'disconnected' {
  const statusRef = useRef<'connected' | 'disconnected'>('disconnected');

  useEffect(() => {
    if (!tenantId) return;
    const s = getSocket(tenantId);
    const onConnect = () => { statusRef.current = 'connected'; };
    const onDisconnect = () => { statusRef.current = 'disconnected'; };
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
    };
  }, [tenantId]);

  return statusRef.current;
}

export interface WaMensajeEvent {
  id: number;
  userId: number | null;
  phone: string;
  contactName?: string | null;
  tipo: string;
  contenido: Record<string, unknown>;
  waMsgId: string | null;
  createdAt: string;
  direccion?: 'entrada' | 'salida';
}

export interface WaStatusEvent {
  waMsgId: string;
  status: string;
  timestamp: string;
}

/**
 * Hook that subscribes to WhatsApp real-time events and keeps React Query
 * caches up to date without triggering a network refetch.
 */
export function useWaSocket(tenantId: string | null) {
  const qc = useQueryClient();

  // nuevo_mensaje → prepend to conversation list + append to thread messages
  const onNuevoMensaje = useCallback(
    (raw: unknown) => {
      const msg = raw as WaMensajeEvent;

      // Update thread list: move this userId to the top with latest message
      qc.setQueryData(
        ['conversaciones', tenantId],
        (old: { data: unknown[] } | undefined) => {
          if (!old) return old;
          const existing = old.data.filter(
            (t: unknown) => (t as { user?: { id: number } }).user?.id !== msg.userId
          );
          // Build a synthetic thread row matching the backend shape
          const updated = {
            id: msg.id,
            userId: msg.userId,
            tipo: msg.tipo,
            contenido: msg.contenido,
            createdAt: msg.createdAt,
            user: { id: msg.userId, phone: msg.phone },
            _contactName: msg.contactName,
          };
          return { data: [updated, ...existing] };
        }
      );

      // Append to open thread if it's the active one
      if (msg.userId) {
        qc.setQueryData(
          ['mensajes', tenantId, msg.userId],
          (old: { data: unknown[] } | undefined) => {
            if (!old) return old;
            return { data: [...old.data, msg] };
          }
        );
      }
    },
    [qc, tenantId]
  );

  // wa_status → update read status badge (future: show tick icons)
  const onWaStatus = useCallback(
    (raw: unknown) => {
      const ev = raw as WaStatusEvent;
      // Invalidate metrics so dashboad refreshes if needed
      qc.invalidateQueries({ queryKey: ['metrics', tenantId] });
      void ev;
    },
    [qc, tenantId]
  );

  useSocket(tenantId, 'nuevo_mensaje', onNuevoMensaje as EventCallback);
  useSocket(tenantId, 'wa_status', onWaStatus as EventCallback);
}
