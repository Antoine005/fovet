/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */
"use client";

import { useEffect, useState, useCallback } from "react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { apiFetch } from "@/lib/api-client";
import type { PtiAlertType } from "@/components/WorkerCard";

interface PtiAlert {
  id: string;
  deviceId: string;
  deviceName: string;
  ptiType: PtiAlertType;
  timestamp: string;
  acknowledged: boolean;
}

const TYPE_STYLES: Record<PtiAlertType, string> = {
  FALL:       "border-red-800/60 bg-red-950/20 text-red-400",
  MOTIONLESS: "border-amber-700/50 bg-amber-950/15 text-amber-400",
  SOS:        "border-red-900/80 bg-red-950/40 text-red-300",
};

const LABEL_FR: Record<PtiAlertType, string> = {
  FALL:       "Chute détectée",
  MOTIONLESS: "Travailleur immobile",
  SOS:        "SOS déclenché",
};

const ICON: Record<PtiAlertType, string> = {
  FALL:       "↓",
  MOTIONLESS: "—",
  SOS:        "!",
};

const POLL_INTERVAL = 10_000;
const PAGE_SIZE = 50;

export function AlertTimeline() {
  const [alerts, setAlerts]   = useState<PtiAlert[]>([]);
  const [error, setError]     = useState<string | null>(null);
  const [acking, setAcking]   = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    apiFetch(`/api/pti/alerts/recent?limit=${PAGE_SIZE}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<PtiAlert[]>;
      })
      .then((data) => { setAlerts(data); setError(null); })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Erreur réseau")
      );
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh]);

  const acknowledge = async (id: string) => {
    setAcking((s) => new Set(s).add(id));
    try {
      await apiFetch(`/api/alerts/${id}/ack`, { method: "PATCH" });
      refresh();
    } finally {
      setAcking((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  const unacked = alerts.filter((a) => !a.acknowledged);
  const acked   = alerts.filter((a) => a.acknowledged);

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">
          Chronologie des alertes PTI
        </h2>
        <div className="flex items-center gap-2">
          {unacked.length > 0 && (
            <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full">
              {unacked.length} active{unacked.length !== 1 ? "s" : ""}
            </span>
          )}
          <button
            onClick={refresh}
            className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
            title="Rafraîchir"
          >
            ↻
          </button>
        </div>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {!error && alerts.length === 0 && (
        <p className="text-gray-600 text-sm">Aucune alerte PTI enregistrée.</p>
      )}

      {alerts.length > 0 && (
        <ul className="space-y-2 max-h-96 overflow-y-auto">
          {unacked.map((a) => (
            <li
              key={a.id}
              className={`rounded-lg border p-3 flex items-start justify-between gap-2 ${TYPE_STYLES[a.ptiType]}`}
            >
              <div className="flex items-start gap-2.5">
                <span className="font-mono text-lg leading-none mt-0.5 w-4 shrink-0 text-center">
                  {ICON[a.ptiType]}
                </span>
                <div>
                  <p className="text-xs font-semibold">{LABEL_FR[a.ptiType]}</p>
                  <p className="text-xs text-gray-300 font-medium mt-0.5">{a.deviceName}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {format(new Date(a.timestamp), "HH:mm:ss — dd/MM/yyyy", { locale: fr })}
                  </p>
                </div>
              </div>
              <button
                onClick={() => void acknowledge(a.id)}
                disabled={acking.has(a.id)}
                className="text-xs text-gray-500 hover:text-white transition-colors shrink-0 disabled:opacity-40"
              >
                Ack
              </button>
            </li>
          ))}

          {acked.length > 0 && (
            <>
              <li className="text-xs text-gray-600 text-center py-1">— acquittées —</li>
              {acked.map((a) => (
                <li
                  key={a.id}
                  className="rounded-lg border border-gray-800 bg-gray-800/30 p-3 flex items-start gap-2.5 opacity-50"
                >
                  <span className="font-mono text-lg leading-none mt-0.5 w-4 shrink-0 text-center text-gray-600">
                    {ICON[a.ptiType]}
                  </span>
                  <div>
                    <p className="text-xs text-gray-500">{LABEL_FR[a.ptiType]} — {a.deviceName}</p>
                    <p className="text-xs text-gray-600">
                      {format(new Date(a.timestamp), "HH:mm:ss — dd/MM/yyyy", { locale: fr })}
                    </p>
                  </div>
                </li>
              ))}
            </>
          )}
        </ul>
      )}
    </div>
  );
}
