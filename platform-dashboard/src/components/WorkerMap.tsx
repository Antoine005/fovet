/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */
"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api-client";
import { WorkerCard, WorkerStatus } from "@/components/WorkerCard";

const POLL_INTERVAL = 10_000;

interface Props {
  onSelectWorker: (deviceId: string) => void;
}

export function WorkerMap({ onSelectWorker }: Props) {
  const [workers, setWorkers] = useState<WorkerStatus[]>([]);
  const [error, setError]     = useState<string | null>(null);

  const refresh = useCallback(() => {
    apiFetch("/api/pti/fleet")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<WorkerStatus[]>;
      })
      .then((data) => { setWorkers(data); setError(null); })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Erreur réseau")
      );
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh]);

  const critical = workers.filter(
    (w) => w.alertsByType.FALL > 0 || w.alertsByType.SOS > 0
  ).length;
  const warning = workers.filter(
    (w) =>
      w.alertsByType.FALL === 0 &&
      w.alertsByType.SOS === 0 &&
      w.alertsByType.MOTIONLESS > 0
  ).length;
  const ok = workers.filter(
    (w) =>
      w.alertsByType.FALL === 0 &&
      w.alertsByType.SOS === 0 &&
      w.alertsByType.MOTIONLESS === 0
  ).length;

  return (
    <div>
      {/* Summary strip */}
      <div className="flex items-center gap-4 mb-4 text-xs">
        <span className="text-gray-400 font-medium">{workers.length} travailleur{workers.length !== 1 ? "s" : ""}</span>
        {critical > 0 && (
          <span className="flex items-center gap-1 text-red-400">
            <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
            {critical} critique{critical !== 1 ? "s" : ""}
          </span>
        )}
        {warning > 0 && (
          <span className="flex items-center gap-1 text-amber-400">
            <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />
            {warning} immobile{warning !== 1 ? "s" : ""}
          </span>
        )}
        {ok > 0 && (
          <span className="flex items-center gap-1 text-green-500">
            <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />
            {ok} OK
          </span>
        )}
        <button
          onClick={refresh}
          className="ml-auto text-gray-600 hover:text-gray-400 transition-colors"
          title="Rafraîchir"
        >
          ↻
        </button>
      </div>

      {error && (
        <p className="text-red-400 text-sm mb-4">{error}</p>
      )}

      {!error && workers.length === 0 && (
        <p className="text-gray-500 text-sm">Aucun travailleur enregistré.</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {workers.map((w) => (
          <WorkerCard
            key={w.id}
            worker={w}
            onSelect={() => onSelectWorker(w.id)}
            onRefresh={refresh}
          />
        ))}
      </div>
    </div>
  );
}
