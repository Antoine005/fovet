/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */
"use client";

import { apiFetch } from "@/lib/api-client";

export type PtiAlertType = "FALL" | "MOTIONLESS" | "SOS";

export interface WorkerStatus {
  id: string;
  name: string;
  location: string | null;
  mqttClientId: string;
  alertsByType: {
    FALL: number;
    MOTIONLESS: number;
    SOS: number;
  };
  lastAlertAt: string | null;
}

interface Props {
  worker: WorkerStatus;
  onSelect?: () => void;
  onRefresh?: () => void;
}

const BADGE_STYLES: Record<PtiAlertType, string> = {
  FALL:       "bg-red-500/20 text-red-400 border border-red-500/30",
  MOTIONLESS: "bg-amber-500/20 text-amber-400 border border-amber-500/30",
  SOS:        "bg-red-600/30 text-red-300 border border-red-600/40",
};

const LABEL_FR: Record<PtiAlertType, string> = {
  FALL:       "Chute",
  MOTIONLESS: "Immobile",
  SOS:        "SOS",
};

function statusColor(w: WorkerStatus): string {
  if (w.alertsByType.FALL > 0 || w.alertsByType.SOS > 0) return "bg-red-500";
  if (w.alertsByType.MOTIONLESS > 0) return "bg-amber-400";
  return "bg-green-400";
}

export function WorkerCard({ worker, onSelect, onRefresh }: Props) {
  const totalAlerts =
    worker.alertsByType.FALL +
    worker.alertsByType.MOTIONLESS +
    worker.alertsByType.SOS;
  const critical = worker.alertsByType.FALL > 0 || worker.alertsByType.SOS > 0;

  async function ackAll() {
    // Re-fetch all unacknowledged alerts for this worker and ack them
    const r = await apiFetch(
      `/api/devices/${worker.id}/alerts?limit=200`
    );
    if (!r.ok) return;
    const { data } = await r.json() as { data: { id: string; ptiType: string | null }[] };
    await Promise.all(
      data
        .filter((a) => a.ptiType !== null)
        .map((a) => apiFetch(`/api/alerts/${a.id}/ack`, { method: "PATCH" }))
    );
    onRefresh?.();
  }

  return (
    <div
      className={`rounded-xl border p-4 flex flex-col gap-3 transition-colors ${
        critical
          ? "border-red-800/60 bg-red-950/15"
          : totalAlerts > 0
          ? "border-amber-800/50 bg-amber-950/10"
          : "border-gray-800 bg-gray-900"
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <button
            onClick={onSelect}
            className="font-semibold text-sm text-white hover:text-blue-300 transition-colors truncate block max-w-full text-left"
          >
            {worker.name}
          </button>
          {worker.location && (
            <p className="text-xs text-gray-500 truncate mt-0.5">{worker.location}</p>
          )}
          <p className="text-xs text-gray-600 font-mono truncate">{worker.mqttClientId}</p>
        </div>
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 mt-1 ${statusColor(worker)}`}
          title={
            critical ? "Alerte critique" : totalAlerts > 0 ? "Alerte active" : "OK"
          }
        />
      </div>

      {/* Alert badges */}
      {totalAlerts > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {(["FALL", "SOS", "MOTIONLESS"] as PtiAlertType[]).map((type) =>
            worker.alertsByType[type] > 0 ? (
              <span
                key={type}
                className={`text-xs px-2 py-0.5 rounded-full font-semibold ${BADGE_STYLES[type]}`}
              >
                {LABEL_FR[type]}
                {worker.alertsByType[type] > 1 && (
                  <span className="ml-1 opacity-70">×{worker.alertsByType[type]}</span>
                )}
              </span>
            ) : null
          )}
        </div>
      ) : (
        <p className="text-xs text-green-500/70">Aucune alerte active</p>
      )}

      {/* Ack button */}
      {totalAlerts > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); void ackAll(); }}
          className="text-xs text-gray-500 hover:text-white transition-colors self-end"
        >
          Acquitter tout
        </button>
      )}
    </div>
  );
}
