'use client';

import { notificationsApi } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

export interface AdminNotification {
  id: number;
  tenantId: string;
  adminUserId: number;
  type: string;
  title: string;
  message: string;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface NotificationListResponse {
  data: AdminNotification[];
  total: number;
  unreadCount: number;
  page: number;
  limit: number;
}

const EMPTY_RESULT: NotificationListResponse = {
  data: [],
  total: 0,
  unreadCount: 0,
  page: 1,
  limit: 10,
};

function key(tenantSlug: string) {
  return ['notifications', tenantSlug] as const;
}

export function useNotifications(tenantSlug: string | null, tenantId: string | null) {
  const qc = useQueryClient();
  const queryKey = tenantSlug ? key(tenantSlug) : (['notifications', 'disabled'] as const);

  const query = useQuery<NotificationListResponse>({
    queryKey,
    queryFn: async () => {
      if (!tenantSlug) return EMPTY_RESULT;
      const res = await notificationsApi.list(tenantSlug, { page: 1, limit: 10 });
      return res.data as NotificationListResponse;
    },
    enabled: Boolean(tenantSlug),
    staleTime: 20_000,
  });

  const onSocketNotification = useCallback((raw: unknown) => {
    if (!tenantSlug) return;
    const incoming = raw as AdminNotification;
    if (!incoming || incoming.tenantId !== tenantId) return;

    qc.setQueryData<NotificationListResponse>(key(tenantSlug), (old) => {
      const base = old ?? EMPTY_RESULT;
      const withoutDup = base.data.filter((item) => item.id !== incoming.id);
      const nextItems = [incoming, ...withoutDup].slice(0, 10);
      const nextUnread = incoming.readAt ? base.unreadCount : base.unreadCount + 1;
      return {
        ...base,
        data: nextItems,
        total: base.total + 1,
        unreadCount: nextUnread,
      };
    });
  }, [qc, tenantId, tenantSlug]);

  useSocket(tenantId, 'notification:new', onSocketNotification);

  const markAsRead = useMutation({
    mutationFn: async (id: number) => {
      if (!tenantSlug) return null;
      const res = await notificationsApi.markAsRead(tenantSlug, id);
      return res.data as AdminNotification;
    },
    onSuccess: (updated) => {
      if (!tenantSlug || !updated) return;
      qc.setQueryData<NotificationListResponse>(key(tenantSlug), (old) => {
        if (!old) return old;
        const wasUnread = old.data.find((item) => item.id === updated.id && !item.readAt);
        return {
          ...old,
          data: old.data.map((item) => (item.id === updated.id ? updated : item)),
          unreadCount: wasUnread ? Math.max(old.unreadCount - 1, 0) : old.unreadCount,
        };
      });
    },
  });

  const markAllAsRead = useMutation({
    mutationFn: async () => {
      if (!tenantSlug) return null;
      const res = await notificationsApi.markAllAsRead(tenantSlug);
      return res.data as { updated: number };
    },
    onSuccess: () => {
      if (!tenantSlug) return;
      qc.setQueryData<NotificationListResponse>(key(tenantSlug), (old) => {
        if (!old) return old;
        return {
          ...old,
          data: old.data.map((item) => ({ ...item, readAt: item.readAt || new Date().toISOString() })),
          unreadCount: 0,
        };
      });
    },
  });

  return {
    notifications: query.data?.data ?? [],
    unreadCount: query.data?.unreadCount ?? 0,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    markAsRead: (id: number) => markAsRead.mutate(id),
    markAllAsRead: () => markAllAsRead.mutate(),
    isMarking: markAsRead.isPending,
    isMarkingAll: markAllAsRead.isPending,
  };
}
