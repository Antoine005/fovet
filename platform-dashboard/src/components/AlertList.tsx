"use client";

import { useEffect, useState, useCallback } from "react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { apiFetch } from "@/lib/api-client";

interface Alert {
  id: string;
  timestamp: string;
  value: number;
  zScore: number;
  threshold: number;
  acknowledged: boolean;
}

interface Props {
  deviceId: string;
}

export function AlertList({ deviceId }: Props) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchAlerts = useCallback(() => {
    apiFetch(`/api/devices/${deviceId}/alerts`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Alert[]) => { setAlerts(data); setError(null); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Erreur réseau"));
  }, [deviceId]);

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 5000);
    return () => clearInterval(interval);
  }, [fetchAlerts]);

  const acknowledge = async (id: string) => {
    await apiFetch(`/api/alerts/${id}/ack`, { method: "PATCH" });
    fetchAlerts();
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-white">Alertes</h2>
        {alerts.length > 0 && (
          <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full">
            {alerts.length}
          </span>
        )}
      </div>

      {error ? (
        <p className="text-red-400 text-sm">{error}</p>
      ) : alerts.length === 0 ? (
        <p className="text-gray-600 text-sm">Aucune alerte active.</p>
      ) : (
        <ul className="space-y-2">
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
      )}
    </div>
  );
}
