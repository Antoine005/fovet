"use client";

import { useEffect, useState, useCallback } from "react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { apiFetch } from "@/lib/api-client";
import { relativeTime } from "@/lib/relative-time";

const PAGE_SIZE = 30;

type SeverityFilter = "all" | "DANGER" | "WARN";

interface FleetAlert {
  id: string;
  deviceId: string;
  deviceName: string;
  timestamp: string;
  value: number;
  zScore: number;
  alertModule: string | null;
  alertLevel: string | null;
  acknowledged: boolean;
}

interface Envelope {
  data: FleetAlert[];
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null };
}

const LEVEL_STYLES: Record<string, string> = {
  DANGER:   "border-red-800/50 bg-red-950/30 text-red-400",
  CRITICAL: "border-red-800/50 bg-red-950/30 text-red-400",
  WARN:     "border-yellow-700/40 bg-yellow-950/20 text-yellow-400",
  COLD:     "border-blue-700/40 bg-blue-950/20 text-blue-400",
  INFO:     "border-gray-700/40 bg-gray-800/30 text-gray-400",
};

const LEVEL_BADGE: Record<string, string> = {
  DANGER:   "bg-red-500/20 text-red-400",
  CRITICAL: "bg-red-500/20 text-red-400",
  WARN:     "bg-yellow-500/20 text-yellow-400",
  COLD:     "bg-blue-500/20 text-blue-400",
  INFO:     "bg-gray-500/20 text-gray-400",
};

function rowStyle(level: string | null): string {
  return level && LEVEL_STYLES[level]
    ? LEVEL_STYLES[level]
    : "border-gray-800/60 bg-gray-900/40 text-gray-400";
}

export function FleetAlertTimeline() {
  const [alerts, setAlerts]         = useState<FleetAlert[]>([]);
  const [hasMore, setHasMore]       = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter]         = useState<SeverityFilter>("all");

  const fetchAlerts = useCallback((reset = true, currentFilter: SeverityFilter = filter) => {
    const levelParam = currentFilter !== "all" ? `&level=${currentFilter}` : "";
    const url = `/api/fleet/alerts/recent?limit=${PAGE_SIZE}${levelParam}`;
    apiFetch(url)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<Envelope>; })
      .then(({ data, pagination }) => {
        setAlerts(reset ? data : (prev) => [...prev, ...data]);
        setHasMore(pagination.hasMore);
        setNextCursor(pagination.nextCursor);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Erreur réseau"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  useEffect(() => {
    fetchAlerts(true, filter);
    const id = setInterval(() => fetchAlerts(true, filter), 10_000);
    return () => clearInterval(id);
  }, [fetchAlerts, filter]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const levelParam = filter !== "all" ? `&level=${filter}` : "";
    try {
      const r = await apiFetch(`/api/fleet/alerts/recent?limit=${PAGE_SIZE}&cursor=${nextCursor}${levelParam}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { data, pagination } = await r.json() as Envelope;
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

  const visible = alerts;
  const unacked = visible.filter((a) => !a.acknowledged).length;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-white">Alertes flotte</h2>
        <div className="flex items-center gap-2">
          {unacked > 0 && (
            <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full">
              {unacked}{hasMore ? "+" : ""}
            </span>
          )}
          <button
            onClick={() => fetchAlerts(true)}
            className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
            title="Rafraîchir"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Severity filter */}
      <div className="flex rounded border border-gray-800 overflow-hidden text-xs mb-3">
        {(["all", "DANGER", "WARN"] as SeverityFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`flex-1 px-2 py-1 transition-colors ${
              filter === f ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {f === "all" ? "Tout" : f === "DANGER" ? "🔴 Critique" : "🟡 Warn"}
          </button>
        ))}
      </div>

      {/* Content */}
      {error ? (
        <p className="text-red-400 text-sm">{error}</p>
      ) : visible.length === 0 ? (
        <p className="text-gray-600 text-sm">
          Aucune alerte{filter !== "all" ? " pour ce filtre" : " enregistrée"}.
        </p>
      ) : (
        <>
          <ul className="space-y-1.5 flex-1 overflow-y-auto">
            {visible.map((a) => (
              <li
                key={a.id}
                className={`rounded-lg border p-2.5 ${rowStyle(a.alertLevel)} ${
                  a.acknowledged ? "opacity-40" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {a.alertLevel && (
                        <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${LEVEL_BADGE[a.alertLevel] ?? "bg-gray-700 text-gray-400"}`}>
                          {a.alertLevel}
                        </span>
                      )}
                      {a.alertModule && (
                        <span className="text-xs text-gray-500 font-mono">{a.alertModule}</span>
                      )}
                      <span className="text-xs font-mono">z={a.zScore.toFixed(2)}σ</span>
                    </div>
                    <p className="text-xs font-medium text-gray-300 mt-0.5 truncate">{a.deviceName}</p>
                    <p
                      className="text-xs text-gray-600"
                      title={format(new Date(a.timestamp), "HH:mm:ss dd/MM/yyyy", { locale: fr })}
                    >
                      {relativeTime(a.timestamp)}
                    </p>
                  </div>
                  {!a.acknowledged && (
                    <button
                      onClick={() => acknowledge(a.id)}
                      className="text-xs text-gray-600 hover:text-white transition-colors shrink-0 border border-gray-700 hover:border-gray-500 rounded px-1.5 py-0.5"
                    >
                      Ack
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {hasMore && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="mt-2 w-full text-xs text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
            >
              {loadingMore ? "Chargement…" : "Charger plus"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
