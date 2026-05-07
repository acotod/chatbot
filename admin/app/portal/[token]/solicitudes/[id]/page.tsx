"use client";

import { portalApi } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDate } from "@/lib/utils";

interface Comment {
  id: number;
  content: string;
  createdAt: string;
  visibility: string;
}

interface SolicitudDetail {
  id: number;
  titulo?: string;
  nombre?: string;
  estado: string;
  prioridad?: string;
  createdAt: string;
  customerNotes?: string;
  comments?: Comment[];
}

export default function PortalSolicitudDetailPage({ params }: { params: { token: string; id: string } }) {
  const token = params.token;
  const solicitudId = Number(params.id);
  const qc = useQueryClient();
  const [comment, setComment] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["portal-solicitud-detail", token, solicitudId],
    queryFn: () => portalApi.detail(token, solicitudId).then((r) => r.data as SolicitudDetail),
    enabled: !!token && Number.isInteger(solicitudId),
  });

  const addComment = useMutation({
    mutationFn: () => portalApi.addComment(token, solicitudId, comment),
    onSuccess: () => {
      setComment("");
      qc.invalidateQueries({ queryKey: ["portal-solicitud-detail", token, solicitudId] });
    },
  });

  const comments = (data?.comments || []).filter((c) => c.visibility === "customer" || c.visibility === "both");

  return (
    <div className="space-y-4">
      <Card className="p-5">
        {isLoading ? (
          <div className="text-sm text-slate-500">Cargando detalle...</div>
        ) : error || !data ? (
          <div className="text-sm text-rose-600">No se pudo cargar la solicitud.</div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">{data.titulo || data.nombre || `Solicitud #${data.id}`}</h2>
                <p className="text-xs text-slate-500 mt-1">Creada: {formatDate(data.createdAt)}</p>
              </div>
              <StatusBadge status={data.estado} />
            </div>
            {data.customerNotes ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <p className="font-medium text-slate-900 mb-1">Notas de soporte</p>
                <p>{data.customerNotes}</p>
              </div>
            ) : null}
          </div>
        )}
      </Card>

      <Card className="p-5 space-y-3">
        <h3 className="font-medium text-slate-900">Comentarios</h3>
        {comments.length === 0 ? (
          <p className="text-sm text-slate-500">No hay comentarios públicos.</p>
        ) : (
          <div className="space-y-2">
            {comments.map((c) => (
              <div key={c.id} className="rounded-lg border border-slate-100 bg-white p-3">
                <p className="text-sm text-slate-700">{c.content}</p>
                <p className="text-xs text-slate-400 mt-1">{formatDate(c.createdAt)}</p>
              </div>
            ))}
          </div>
        )}

        <div className="pt-2 space-y-2">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Escribe un comentario para el equipo de soporte"
            className="w-full min-h-24 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
          <div className="flex justify-end">
            <Button
              onClick={() => addComment.mutate()}
              disabled={!comment.trim() || addComment.isPending}
            >
              {addComment.isPending ? "Enviando..." : "Enviar comentario"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
