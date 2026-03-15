"use client";

/**
 * Fovet Vigie — FleetHealth
 *
 * "Santé flotte" view: one row per active device, three module status badges
 * (PTI / FATIGUE / THERMAL) aggregated from unacknowledged alerts.
 *
 * Polls GET /api/fleet/health every 15 s.
 */

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api-client";

// -----------------------------------------------------------------
// Types
// -----------------------------------------------------------------

interface ModuleHealth {
  status: "OK" | "WARN" | "DANGER" | "CRITICAL";
  count: number;
  lastAt: string | null;
}

interface DeviceHealth {
  id: string;
  name: string;
  location: string | null;
  mqttClientId: string;
  modules: {
    PTI:     ModuleHealth;
    FATIGUE: ModuleHealth;
    THERMAL: ModuleHealth;
  };
}

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

const STATUS_STYLES: Record<string, string> = {
  OK:       "bg-green-900/30  text-green-300  border border-green-700",
  WARN:     "bg-amber-900/30  text-amber-300  border border-amber-600",
  DANGER:   "bg-red-900/30    text-red-300    border border-red-700 animate-pulse",
  CRITICAL: "bg-red-900/60    text-red-200    border border-red-500 animate-pulse",
};

const STATUS_LABEL: Record<string, string> = {
  OK:       "OK",
  WARN:     "WARN",
  DANGER:   "DANGER",
  CRITICAL: "CRITIQUE",
};

/** Worst status across all 3 modules for the row summary dot */
function worstStatus(d: DeviceHealth): string {
  const rank = { OK: 0, WARN: 1, DANGER: 2, CRITICAL: 3 };
  const statuses = [d.modules.PTI.status, d.modules.FATIGUE.status, d.modules.THERMAL.status];
  return statuses.reduce((worst, s) => (rank[s] > rank[worst] ? s : worst), "OK");
}

const DOT_STYLES: Record<string, string> = {
  OK:       "bg-green-400",
  WARN:     "bg-amber-400",
  DANGER:   "bg-red-500 animate-pulse",
  CRITICAL: "bg-red-400 animate-pulse",
};

function ModuleBadge({ label, module }: { label: string; module: ModuleHealth }) {
  const style = STATUS_STYLES[module.status] ?? STATUS_STYLES.OK;
  return (
    <div className={`rounded px-2 py-1 text-center min-w-[90px] ${style}`}>
      <div className="text-[10px] font-bold uppercase tracking-widest opacity-70">{label}</div>
      <div className="text-sm font-semibold">{STATUS_LABEL[module.status] ?? module.status}</div>
      {module.count > 0 && (
        <div className="text-[10px] opacity-60">{module.count} alerte{module.count > 1 ? "s" : ""}</div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------
// Main component
// -----------------------------------------------------------------

const POLL_INTERVAL = 15_000;

export default function FleetHealth() {
  const [devices, setDevices] = useState<DeviceHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await apiFetch("/api/fleet/health");
      if (!res.ok) {
        setError(`Erreur API: ${res.status}`);
        return;
      }
      const data: DeviceHealth[] = await res.json();
      setDevices(data);
      setError(null);
      setLastRefresh(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur réseau");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const timer = setInterval(fetchHealth, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchHealth]);

  // -----------------------------------------------------------------
  // Summary bar
  // -----------------------------------------------------------------
  const critical = devices.filter((d) => worstStatus(d) === "CRITICAL" || worstStatus(d) === "DANGER").length;
  const warned   = devices.filter((d) => worstStatus(d) === "WARN").length;
  const ok       = devices.filter((d) => worstStatus(d) === "OK").length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">Santé flotte</h2>
        {lastRefresh && (
          <span className="text-xs text-gray-500">
            Actualisé {lastRefresh.toLocaleTimeString("fr-FR")}
          </span>
        )}
      </div>

      {/* Summary banner */}
      {!loading && devices.length > 0 && (
        <div className="flex gap-4 p-3 rounded-lg bg-gray-800 border border-gray-700 text-sm">
          {critical > 0 && (
            <span className="text-red-400 font-semibold animate-pulse">
              🔴 {critical} critique{critical > 1 ? "s" : ""}
            </span>
          )}
          {warned > 0 && (
            <span className="text-amber-400 font-semibold">
              🟡 {warned} alerte{warned > 1 ? "s" : ""}
            </span>
          )}
          {ok > 0 && (
            <span className="text-green-400">
              🟢 {ok} normal{ok > 1 ? "s" : ""}
            </span>
          )}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="p-3 rounded bg-red-900/30 border border-red-700 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="text-center text-gray-400 py-8 text-sm">Chargement…</div>
      )}

      {/* Empty state */}
      {!loading && !error && devices.length === 0 && (
        <div className="text-center text-gray-500 py-8 text-sm">Aucun dispositif actif.</div>
      )}

      {/* Device rows */}
      {!loading && devices.length > 0 && (
        <div className="space-y-2">
          {devices.map((d) => {
            const ws = worstStatus(d);
            return (
              <div
                key={d.id}
                className="flex items-center gap-4 p-4 rounded-lg bg-gray-800 border border-gray-700"
              >
                {/* Status dot */}
                <span className={`w-3 h-3 rounded-full shrink-0 ${DOT_STYLES[ws] ?? DOT_STYLES.OK}`} />

                {/* Device name + location */}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-white truncate">{d.name}</div>
                  {d.location && (
                    <div className="text-xs text-gray-400 truncate">{d.location}</div>
                  )}
                  <div className="text-[10px] text-gray-600 font-mono">{d.mqttClientId}</div>
                </div>

                {/* Module badges */}
                <div className="flex gap-2 shrink-0">
                  <ModuleBadge label="PTI"     module={d.modules.PTI}     />
                  <ModuleBadge label="Fatigue" module={d.modules.FATIGUE} />
                  <ModuleBadge label="Therm."  module={d.modules.THERMAL} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
