"use client";

import { useEffect, useState, useCallback } from "react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { apiFetch } from "@/lib/api-client";

const PAGE_SIZE = 20;

interface Alert {
  id: string;
  timestamp: string;
  value: number;
  zScore: number;
  threshold: number;
  acknowledged: boolean;
}

interface AlertsEnvelope {
  data: Alert[];
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null };
}

interface Props {
  deviceId: string;
}

export function AlertList({ deviceId }: Props) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchAlerts = useCallback((reset = true) => {
    const url = `/api/devices/${deviceId}/alerts?limit=${PAGE_SIZE}`;
    apiFetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<AlertsEnvelope>;
      })
      .then(({ data, pagination }) => {
        setAlerts(reset ? data : (prev) => [...prev, ...data] as Alert[]);
        setHasMore(pagination.hasMore);
        setNextCursor(pagination.nextCursor);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Erreur réseau")
      );
  }, [deviceId]);

  useEffect(() => {
    fetchAlerts(true);
    const interval = setInterval(() => fetchAlerts(true), 10_000);
    return () => clearInterval(interval);
  }, [fetchAlerts]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const url = `/api/devices/${deviceId}/alerts?limit=${PAGE_SIZE}&cursor=${nextCursor}`;
      const r = await apiFetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { data, pagination } = await r.json() as AlertsEnvelope;
      setAlerts((prev) => [...prev, ...data]);
      setHasMore(pagination.hasMore);
      setNextCursor(pagination.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur réseau");
    } finally {
      setLoadingMore(false);
    }
  };

  const acknowledge = async (id: string) => {
    await apiFetch(`/api/alerts/${id}/ack`, { method: "PATCH" });
    fetchAlerts(true);
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-white">Alertes</h2>
        {alerts.length > 0 && (
          <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full">
            {alerts.length}{hasMore ? "+" : ""}
          </span>
        )}
      </div>

      {error ? (
        <p className="text-red-400 text-sm">{error}</p>
      ) : alerts.length === 0 ? (
        <p className="text-gray-600 text-sm">Aucune alerte active.</p>
      ) : (
        <>
          <ul className="space-y-2 flex-1 overflow-y-auto">
            {alerts.map((a) => (
              <li
                key={a.id}
                className="rounded-lg border border-red-900/50 bg-red-950/30 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs text-red-400 font-mono font-semibold">
                      z = {a.zScore.toFixed(2)}σ
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {format(new Date(a.timestamp), "HH:mm:ss dd/MM", { locale: fr })}
                    </p>
                    <p className="text-xs text-gray-600 font-mono">
                      val = {a.value.toFixed(4)}
                    </p>
                  </div>
                  <button
                    onClick={() => acknowledge(a.id)}
                    className="text-xs text-gray-500 hover:text-white shrink-0 mt-0.5 transition-colors"
                  >
                    Ack
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {hasMore && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="mt-3 w-full text-xs text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
            >
              {loadingMore ? "Chargement…" : "Charger plus"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
