"use client";

import { useEffect, useState, useCallback } from "react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { apiFetch } from "@/lib/api-client";

const PAGE_SIZE = 20;

type SeverityFilter = "all" | "DANGER" | "WARN";
type RefreshInterval = 5 | 10 | 30 | 0; // 0 = paused

interface Alert {
  id: string;
  timestamp: string;
  value: number;
  zScore: number;
  threshold: number;
  acknowledged: boolean;
  alertModule: string | null;
  alertLevel: string | null;
}

interface AlertsEnvelope {
  data: Alert[];
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null };
}

interface Props {
  deviceId: string;
}

const LEVEL_STYLES: Record<string, string> = {
  DANGER:   "border-red-700/60 bg-red-950/40 text-red-400",
  CRITICAL: "border-red-700/60 bg-red-950/40 text-red-400",
  WARN:     "border-yellow-700/50 bg-yellow-950/30 text-yellow-400",
  COLD:     "border-blue-700/50 bg-blue-950/30 text-blue-400",
};

const LEVEL_BADGE: Record<string, string> = {
  DANGER:   "bg-red-500/20 text-red-400",
  CRITICAL: "bg-red-500/20 text-red-400",
  WARN:     "bg-yellow-500/20 text-yellow-400",
  COLD:     "bg-blue-500/20 text-blue-400",
};

const REFRESH_LABELS: Record<number, string> = {
  5: "5s", 10: "10s", 30: "30s", 0: "⏸",
};

function alertStyle(level: string | null): string {
  return level && LEVEL_STYLES[level]
    ? LEVEL_STYLES[level]
    : "border-red-900/50 bg-red-950/30 text-red-400";
}

function matchesSeverity(a: Alert, filter: SeverityFilter): boolean {
  if (filter === "all") return true;
  if (filter === "DANGER") return a.alertLevel === "DANGER" || a.alertLevel === "CRITICAL";
  if (filter === "WARN")   return a.alertLevel === "WARN" || a.alertLevel === "COLD";
  return true;
}

export function AlertList({ deviceId }: Props) {
  const [alerts, setAlerts]           = useState<Alert[]>([]);
  const [hasMore, setHasMore]         = useState(false);
  const [nextCursor, setNextCursor]   = useState<string | null>(null);
  const [error, setError]             = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter]           = useState<SeverityFilter>("all");
  const [refreshMs, setRefreshMs]     = useState<RefreshInterval>(10);

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
    if (refreshMs === 0) return;
    const interval = setInterval(() => fetchAlerts(true), refreshMs * 1000);
    return () => clearInterval(interval);
  }, [fetchAlerts, refreshMs]);

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

  const acknowledgeAll = async () => {
    const visible = alerts.filter((a) => matchesSeverity(a, filter));
    await Promise.all(visible.map((a) => apiFetch(`/api/alerts/${a.id}/ack`, { method: "PATCH" })));
    fetchAlerts(true);
  };

  const visible = alerts.filter((a) => matchesSeverity(a, filter));

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-white">Alertes</h2>
        {visible.length > 0 && (
          <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full">
            {visible.length}{hasMore ? "+" : ""}
          </span>
        )}
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {/* Severity filter */}
        <div className="flex rounded border border-gray-800 overflow-hidden text-xs">
          {(["all", "DANGER", "WARN"] as SeverityFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-1 transition-colors ${
                filter === f
                  ? "bg-gray-700 text-white"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {f === "all" ? "Tout" : f === "DANGER" ? "🔴 Critique" : "🟡 Warn"}
            </button>
          ))}
        </div>

        {/* Refresh interval */}
        <div className="flex rounded border border-gray-800 overflow-hidden text-xs ml-auto">
          {([5, 10, 30, 0] as RefreshInterval[]).map((ms) => (
            <button
              key={ms}
              onClick={() => setRefreshMs(ms)}
              title={ms === 0 ? "Pause" : `Rafraîchir toutes les ${ms}s`}
              className={`px-2 py-1 transition-colors ${
                refreshMs === ms
                  ? "bg-gray-700 text-white"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {REFRESH_LABELS[ms]}
            </button>
          ))}
        </div>

        {/* Ack all */}
        {visible.length > 1 && (
          <button
            onClick={acknowledgeAll}
            className="text-xs text-gray-500 hover:text-white transition-colors px-2 py-1 border border-gray-800 rounded"
            title="Acquitter toutes les alertes visibles"
          >
            Ack tout
          </button>
        )}
      </div>

      {error ? (
        <p className="text-red-400 text-sm">{error}</p>
      ) : visible.length === 0 ? (
        <p className="text-gray-600 text-sm">Aucune alerte{filter !== "all" ? " pour ce filtre" : " active"}.</p>
      ) : (
        <>
          <ul className="space-y-2 flex-1 overflow-y-auto">
            {visible.map((a) => (
              <li
                key={a.id}
                className={`rounded-lg border p-3 ${alertStyle(a.alertLevel)}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-xs font-mono font-semibold">
                        z = {a.zScore.toFixed(2)}σ
                      </p>
                      {a.alertLevel && (
                        <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${LEVEL_BADGE[a.alertLevel] ?? "bg-gray-700 text-gray-400"}`}>
                          {a.alertLevel}
                        </span>
                      )}
                      {a.alertModule && (
                        <span className="text-xs text-gray-500 font-mono">{a.alertModule}</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {format(new Date(a.timestamp), "HH:mm:ss dd/MM", { locale: fr })}
                    </p>
                    <p className="text-xs text-gray-600 font-mono">
                      val = {a.value.toFixed(4)}
                    </p>
                  </div>
                  <button
                    onClick={() => acknowledge(a.id)}
                    className="text-xs text-gray-500 hover:text-white shrink-0 mt-0.5 transition-colors border border-gray-700 hover:border-gray-500 rounded px-1.5 py-0.5"
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
