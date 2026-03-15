"use client";

/**
 * Fovet Vigie — WorkerDetail (U2)
 *
 * Vue individuelle multi-capteur d'un travailleur :
 * statut PTI + niveau fatigue + niveau thermique + chronologie alertes.
 *
 * Consomme GET /api/workers/:deviceId/summary (poll 15 s).
 * La logique EMA/WBGT/classify est calquée sur FatigueCard / TempCard.
 */

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api-client";

// -----------------------------------------------------------------
// Shared thresholds — must match Sentinelle profile headers
// -----------------------------------------------------------------

// H2 Fatigue
const HR_OK     = 72;
const HR_ALERT  = 82;
const EMA_ALPHA_HR = 0.05;
const WARMUP_HR    = 25;

// H3 Thermal
const WBGT_WARN_C   = 25;
const WBGT_DANGER_C = 28;
const COLD_ALERT_C  = 10;
const EMA_ALPHA_T   = 0.10;
const WARMUP_T      = 10;

// -----------------------------------------------------------------
// Types
// -----------------------------------------------------------------

interface DeviceSummary {
  device: {
    id: string;
    name: string;
    location: string | null;
    mqttClientId: string;
    active: boolean;
  };
  pti: {
    alertsByType: { FALL: number; MOTIONLESS: number; SOS: number };
    lastAlertAt: string | null;
  };
  fatigue: { readings: { id: string; value: number; timestamp: string }[] };
  thermal: { readings: { id: string; value: number; value2: number | null; timestamp: string }[] };
  recentAlerts: {
    id: string;
    timestamp: string;
    value: number;
    zScore: number;
    ptiType: string | null;
    alertModule: string | null;
    alertLevel: string | null;
    acknowledged: boolean;
  }[];
}

type PtiStatus  = "CRITICAL" | "MOTIONLESS" | "OK";
type FatigueLevel = "UNKNOWN" | "OK" | "ALERT" | "CRITICAL";
type ThermalLevel = "UNKNOWN" | "SAFE" | "WARN" | "DANGER" | "COLD";

// -----------------------------------------------------------------
// EMA + classify helpers
// -----------------------------------------------------------------

function computeEma(values: number[], alpha: number): number | null {
  if (values.length === 0) return null;
  let ema = values[0];
  for (let i = 1; i < values.length; i++) ema = alpha * values[i] + (1 - alpha) * ema;
  return ema;
}

function computeWbgt(celsius: number, humidityPct: number): number {
  const H = humidityPct;
  const T = celsius;
  const nwb =
    T * Math.atan(0.151977 * Math.sqrt(H + 8.313659)) +
    Math.atan(T + H) -
    Math.atan(H - 1.676331) +
    0.00391838 * Math.pow(H, 1.5) * Math.atan(0.023101 * H) -
    4.686035;
  return 0.7 * nwb + 0.3 * T;
}

function classifyFatigue(readings: { value: number }[], count: number): FatigueLevel {
  if (count < WARMUP_HR) return "UNKNOWN";
  const ema = computeEma(readings.map((r) => r.value), EMA_ALPHA_HR);
  if (ema === null) return "UNKNOWN";
  if (ema > HR_ALERT) return "CRITICAL";
  if (ema >= HR_OK)   return "ALERT";
  return "OK";
}

function classifyThermal(readings: { value: number; value2: number | null }[], count: number): ThermalLevel {
  if (count < WARMUP_T) return "UNKNOWN";
  const ema = computeEma(readings.map((r) => r.value), EMA_ALPHA_T);
  if (ema === null) return "UNKNOWN";
  const humidity = readings.at(-1)?.value2 ?? 50;
  if (ema <= COLD_ALERT_C) return "COLD";
  const wbgt = computeWbgt(ema, humidity);
  if (wbgt >= WBGT_DANGER_C) return "DANGER";
  if (wbgt >= WBGT_WARN_C)   return "WARN";
  return "SAFE";
}

function ptiStatus(alertsByType: { FALL: number; MOTIONLESS: number; SOS: number }): PtiStatus {
  if (alertsByType.FALL > 0 || alertsByType.SOS > 0) return "CRITICAL";
  if (alertsByType.MOTIONLESS > 0) return "MOTIONLESS";
  return "OK";
}

// -----------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------

function StatusDot({ status }: { status: "OK" | "WARN" | "DANGER" | "CRITICAL" | "MOTIONLESS" | "UNKNOWN" | "SAFE" | "COLD" | "ALERT" }) {
  const map: Record<string, string> = {
    OK:         "bg-green-400",
    SAFE:       "bg-green-400",
    WARN:       "bg-amber-400",
    ALERT:      "bg-amber-400",
    MOTIONLESS: "bg-amber-400",
    DANGER:     "bg-red-500 animate-pulse",
    CRITICAL:   "bg-red-500 animate-pulse",
    COLD:       "bg-blue-400",
    UNKNOWN:    "bg-gray-600",
  };
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${map[status] ?? "bg-gray-600"}`} />;
}

const PTI_BADGE_STYLES: Record<string, string> = {
  FALL:       "bg-red-500/20 text-red-400 border border-red-500/30",
  MOTIONLESS: "bg-amber-500/20 text-amber-400 border border-amber-500/30",
  SOS:        "bg-red-600/30 text-red-300 border border-red-600/40",
};
const PTI_LABEL_FR: Record<string, string> = {
  FALL: "Chute", MOTIONLESS: "Immobile", SOS: "SOS",
};

const ALERT_MODULE_FR: Record<string, string> = {
  PTI: "PTI", FATIGUE: "Fatigue", THERMAL: "Thermique",
};
const ALERT_LEVEL_COLOR: Record<string, string> = {
  CRITICAL: "text-red-400",
  DANGER:   "text-red-400",
  WARN:     "text-amber-400",
  COLD:     "text-blue-400",
};

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">{title}</h3>
      {children}
    </div>
  );
}

// -----------------------------------------------------------------
// Main component
// -----------------------------------------------------------------

const POLL_INTERVAL = 15_000;

interface Props {
  deviceId: string;
  onBack: () => void;
}

export default function WorkerDetail({ deviceId, onBack }: Props) {
  const [summary, setSummary] = useState<DeviceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/workers/${deviceId}/summary`);
      if (!res.ok) { setError(`Erreur API: ${res.status}`); return; }
      setSummary(await res.json());
      setError(null);
      setLastRefresh(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur réseau");
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    setLoading(true);
    fetch_();
    const t = setInterval(fetch_, POLL_INTERVAL);
    return () => clearInterval(t);
  }, [fetch_]);

  if (loading) return <div className="text-center text-gray-400 py-12 text-sm">Chargement…</div>;
  if (error)   return <div className="p-4 rounded bg-red-900/30 border border-red-700 text-red-300 text-sm">{error}</div>;
  if (!summary) return null;

  const { device, pti, fatigue, thermal, recentAlerts } = summary;

  const ptiSt     = ptiStatus(pti.alertsByType);
  const fatigueLv = classifyFatigue(fatigue.readings, fatigue.readings.length);
  const thermalLv = classifyThermal(thermal.readings, thermal.readings.length);

  const fatigueEma = computeEma(fatigue.readings.map((r) => r.value), EMA_ALPHA_HR);
  const thermalEma = computeEma(thermal.readings.map((r) => r.value), EMA_ALPHA_T);
  const thermalHumidity = thermal.readings.at(-1)?.value2 ?? null;
  const thermalWbgt = thermalEma !== null && thermalHumidity !== null
    ? computeWbgt(thermalEma, thermalHumidity)
    : null;

  const FATIGUE_LABEL: Record<FatigueLevel, string> = { UNKNOWN: "En attente", OK: "Normal", ALERT: "Élevé", CRITICAL: "Critique" };
  const THERMAL_LABEL: Record<ThermalLevel, string> = { UNKNOWN: "En attente", SAFE: "Normal", WARN: "Attention", DANGER: "Danger", COLD: "Froid" };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors px-2 py-1 rounded border border-gray-700"
        >
          ← Retour
        </button>
        <div className="flex-1">
          <h2 className="text-xl font-semibold text-white">{device.name}</h2>
          {device.location && <p className="text-xs text-gray-400">{device.location}</p>}
          <p className="text-[10px] font-mono text-gray-600">{device.mqttClientId}</p>
        </div>
        {lastRefresh && (
          <span className="text-xs text-gray-500">
            {lastRefresh.toLocaleTimeString("fr-FR")}
          </span>
        )}
      </div>

      {/* Module status row */}
      <div className="grid grid-cols-3 gap-3">
        {/* PTI */}
        <SectionCard title="PTI — H1">
          <div className="flex items-center gap-2 mb-2">
            <StatusDot status={ptiSt} />
            <span className={`text-sm font-semibold ${ptiSt === "OK" ? "text-green-400" : ptiSt === "MOTIONLESS" ? "text-amber-400" : "text-red-400"}`}>
              {ptiSt === "OK" ? "Normal" : ptiSt === "MOTIONLESS" ? "Immobile" : "Critique"}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {(["FALL", "SOS", "MOTIONLESS"] as const).map((type) =>
              pti.alertsByType[type] > 0 ? (
                <span key={type} className={`text-xs px-2 py-0.5 rounded-full font-semibold ${PTI_BADGE_STYLES[type]}`}>
                  {PTI_LABEL_FR[type]} ×{pti.alertsByType[type]}
                </span>
              ) : null
            )}
            {pti.alertsByType.FALL === 0 && pti.alertsByType.MOTIONLESS === 0 && pti.alertsByType.SOS === 0 && (
              <span className="text-xs text-green-500/70">Aucune alerte</span>
            )}
          </div>
          {pti.lastAlertAt && (
            <p className="text-[10px] text-gray-600 mt-2">
              Dernière : {new Date(pti.lastAlertAt).toLocaleString("fr-FR")}
            </p>
          )}
        </SectionCard>

        {/* Fatigue */}
        <SectionCard title="Fatigue — H2">
          <div className="flex items-center gap-2 mb-1">
            <StatusDot status={fatigueLv} />
            <span className={`text-sm font-semibold ${
              fatigueLv === "CRITICAL" ? "text-red-400 animate-pulse" :
              fatigueLv === "ALERT"    ? "text-amber-400" :
              fatigueLv === "OK"       ? "text-green-400" : "text-gray-500"
            }`}>
              {FATIGUE_LABEL[fatigueLv]}
            </span>
          </div>
          {fatigueEma !== null ? (
            <p className="text-lg font-bold text-white">{fatigueEma.toFixed(1)} <span className="text-xs text-gray-500">BPM (EMA)</span></p>
          ) : (
            <p className="text-xs text-gray-600">Pas de lecture HR</p>
          )}
          <p className="text-[10px] text-gray-600 mt-1">α=0.05 · seuils 72/82 bpm</p>
        </SectionCard>

        {/* Thermal */}
        <SectionCard title="Thermique — H3">
          <div className="flex items-center gap-2 mb-1">
            <StatusDot status={thermalLv} />
            <span className={`text-sm font-semibold ${
              thermalLv === "DANGER"  ? "text-red-400 animate-pulse" :
              thermalLv === "WARN"    ? "text-amber-400" :
              thermalLv === "COLD"    ? "text-blue-400" :
              thermalLv === "SAFE"    ? "text-green-400" : "text-gray-500"
            }`}>
              {THERMAL_LABEL[thermalLv]}
            </span>
          </div>
          {thermalEma !== null ? (
            <p className="text-lg font-bold text-white">{thermalEma.toFixed(1)} <span className="text-xs text-gray-500">°C (EMA)</span></p>
          ) : (
            <p className="text-xs text-gray-600">Pas de lecture TEMP</p>
          )}
          {thermalWbgt !== null && (
            <p className="text-xs text-gray-400">WBGT {thermalWbgt.toFixed(1)} °C</p>
          )}
          <p className="text-[10px] text-gray-600 mt-1">seuils 25/28 WBGT · froid ≤10°C</p>
        </SectionCard>
      </div>

      {/* Recent alerts timeline */}
      <SectionCard title="Alertes récentes (20 dernières)">
        {recentAlerts.length === 0 ? (
          <p className="text-xs text-green-500/70">Aucune alerte enregistrée.</p>
        ) : (
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {recentAlerts.map((a) => {
              const label = a.ptiType
                ? PTI_LABEL_FR[a.ptiType] ?? a.ptiType
                : a.alertModule
                ? `${ALERT_MODULE_FR[a.alertModule] ?? a.alertModule}${a.alertLevel ? " — " + a.alertLevel : ""}`
                : `z=${a.zScore.toFixed(2)}`;
              const color = a.ptiType && (a.ptiType === "FALL" || a.ptiType === "SOS")
                ? "text-red-400"
                : a.alertLevel
                ? ALERT_LEVEL_COLOR[a.alertLevel] ?? "text-gray-400"
                : "text-gray-400";
              return (
                <div key={a.id} className="flex items-baseline gap-2 text-xs">
                  <span className="text-gray-600 shrink-0">
                    {new Date(a.timestamp).toLocaleString("fr-FR")}
                  </span>
                  <span className={`font-semibold ${color}`}>{label}</span>
                  {a.acknowledged && (
                    <span className="text-gray-700 text-[10px]">✓ acquitté</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
