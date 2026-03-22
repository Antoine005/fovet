"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { apiFetch } from "@/lib/api-client";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { format } from "date-fns";
import { fr } from "date-fns/locale";

const MAX_READINGS = 2000;
const CONNECTED_THRESHOLD_MS = 30_000;

const WINDOW_OPTIONS = [
  { label: "30s",   ms:     30_000 },
  { label: "100s",  ms:    100_000 },
  { label: "5 min", ms:    300_000 },
  { label: "15 min", ms:   900_000 },
] as const;

interface Reading {
  id: string;
  timestamp: string;
  value: number;
  mean: number;
  stddev: number;
  zScore: number;
  isAnomaly: boolean;
  // Manifest-driven fields (canonical v2)
  unit?: string | null;
  valueMin?: number | null;
  valueMax?: number | null;
  label?: string | null;
  modelId?: string | null;
}

interface Props {
  deviceId: string;
}

const SSE_MAX_RETRIES = 5;
const SSE_BASE_DELAY_MS = 1_000;
const SSE_MAX_DELAY_MS = 30_000;

/** Pick the first non-null value of a field from an array of readings. */
function firstDefined<T>(readings: Reading[], key: keyof Reading): T | undefined {
  for (const r of readings) {
    const v = r[key];
    if (v !== null && v !== undefined) return v as T;
  }
  return undefined;
}

export function ReadingChart({ deviceId }: Props) {
  const [readings, setReadings] = useState<Reading[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"sse" | "polling">("sse");
  const [windowMs, setWindowMs] = useState(100_000);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);
  const isConnectedRef = useRef(false);
  const modeRef = useRef<"sse" | "polling">("sse");
  const connectSSERef = useRef<(() => void) | null>(null);

  // 1-second tick — only slides the window when the device is connected
  useEffect(() => {
    const interval = setInterval(() => {
      if (isConnectedRef.current) setNowMs(Date.now());
    }, 1_000);
    return () => clearInterval(interval);
  }, []);

  const appendReading = useCallback((r: Reading) => {
    setReadings((prev) => {
      const next = [...prev, r];
      return next.length > MAX_READINGS ? next.slice(-MAX_READINGS) : next;
    });
  }, []);

  const fetchInitial = useCallback(() => {
    apiFetch(`/api/devices/${deviceId}/readings?limit=${MAX_READINGS}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((envelope: { data: Reading[] }) => {
        setReadings(envelope.data);
        setError(null);
        // When polling succeeds, recover SSE immediately instead of waiting for the 60s timer.
        if (modeRef.current === "polling" && connectSSERef.current) {
          if (retryTimerRef.current !== null) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
          }
          retryCountRef.current = 0;
          connectSSERef.current();
        }
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Erreur réseau")
      );
  }, [deviceId]);

  // Keep modeRef in sync with mode state for use in fetchInitial callback.
  modeRef.current = mode;

  // SSE connection with exponential backoff — falls back to polling after
  // SSE_MAX_RETRIES consecutive failures. Polling recovery re-triggers SSE
  // on the first successful fetch rather than waiting for the 60s fixed timer.
  useEffect(() => {
    unmountedRef.current = false;
    retryCountRef.current = 0;
    fetchInitial();

    function connectSSE() {
      if (unmountedRef.current) return;

      const es = new EventSource(`/api/devices/${deviceId}/stream`);
      eventSourceRef.current = es;
      connectSSERef.current = connectSSE;
      setMode("sse");

      es.addEventListener("reading", (e: MessageEvent) => {
        try {
          appendReading(JSON.parse(e.data) as Reading);
          setError(null);
          retryCountRef.current = 0;
        } catch {
          // ignore parse errors
        }
      });

      es.onerror = () => {
        es.close();
        eventSourceRef.current = null;

        if (unmountedRef.current) return;

        retryCountRef.current += 1;
        if (retryCountRef.current >= SSE_MAX_RETRIES) {
          // Switch to polling — recovery happens automatically when the next
          // successful poll is received (see fetchInitial).
          setMode("polling");
          return;
        }

        const delay = Math.min(
          SSE_BASE_DELAY_MS * 2 ** (retryCountRef.current - 1),
          SSE_MAX_DELAY_MS
        );
        retryTimerRef.current = setTimeout(connectSSE, delay);
      };
    }

    connectSSE();

    return () => {
      unmountedRef.current = true;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [deviceId, fetchInitial, appendReading]);

  // Polling fallback when SSE is unavailable
  useEffect(() => {
    if (mode !== "polling") return;
    const interval = setInterval(fetchInitial, 5000);
    return () => clearInterval(interval);
  }, [mode, fetchInitial]);

  // Freeze the window when no reading has arrived in the last 30s
  const latestReading = readings[readings.length - 1];
  const isConnected =
    latestReading !== undefined &&
    Date.now() - new Date(latestReading.timestamp).getTime() < CONNECTED_THRESHOLD_MS;
  isConnectedRef.current = isConnected;

  const windowed = readings.filter(
    (r) => nowMs - new Date(r.timestamp).getTime() <= windowMs
  );

  // --- Derive display metadata from readings (manifest-driven) ---

  // Use the most recent reading that has a non-null unit/range
  const displayReadings = windowed.length > 0 ? windowed : readings.slice(-10);
  const unit     = firstDefined<string>(displayReadings, "unit") ?? "";
  const valueMin = firstDefined<number>(displayReadings, "valueMin");
  const valueMax = firstDefined<number>(displayReadings, "valueMax");
  const modelId  = firstDefined<string>(displayReadings, "modelId");

  // Y-axis domain: use manifest range if available, else auto
  const yDomain: [number | string, number | string] =
    valueMin !== undefined && valueMax !== undefined
      ? [valueMin, valueMax]
      : ["auto", "auto"];

  // Show the running mean line only when it carries meaningful info
  // (legacy payloads set mean to non-zero; canonical payloads set it to 0)
  const hasMean = windowed.some((r) => r.mean !== 0);

  const chartData = windowed.map((r) => ({
    ts:      format(new Date(r.timestamp), "HH:mm:ss", { locale: fr }),
    value:   r.value,
    mean:    hasMean ? r.mean : undefined,
    anomaly: r.isAnomaly ? r.value : null,
    label:   r.label ?? undefined,
  }));

  // Y-axis label: show unit if known
  const yAxisLabel = unit
    ? { value: unit, angle: -90, position: "insideLeft" as const, style: { fill: "#6b7280", fontSize: 10 } }
    : undefined;

  // Custom tooltip formatter to show unit
  const tooltipFormatter = (value: number, name: string) => {
    if (name === "Valeur" && unit) return [`${value} ${unit}`, name];
    if (name === "Anomalie" && value !== null) return [`${value} ${unit || ""}`, name];
    return [value, name];
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-white">Signal capteur</h2>
          {modelId && (
            <span className="text-xs text-indigo-400 bg-indigo-900/30 px-2 py-0.5 rounded font-mono">
              {modelId}
            </span>
          )}
          {unit && !modelId && (
            <span className="text-xs text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
              {unit}
            </span>
          )}
        </div>
        <span className="text-xs text-gray-500">
          {mode === "sse" ? "temps réel" : "5s"}
        </span>
      </div>

      {/* Time window selector */}
      <div className="flex rounded border border-gray-800 overflow-hidden text-xs mb-3 w-fit">
        {WINDOW_OPTIONS.map((opt) => (
          <button
            key={opt.ms}
            onClick={() => setWindowMs(opt.ms)}
            className={`px-2.5 py-1 transition-colors ${
              windowMs === opt.ms
                ? "bg-gray-700 text-white"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="h-48 flex items-center justify-center text-red-400 text-sm">
          {error}
        </div>
      ) : windowed.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-gray-600 text-sm">
          {readings.length > 0
            ? `Aucune mesure dans la fenêtre ${WINDOW_OPTIONS.find((o) => o.ms === windowMs)?.label ?? ""}`
            : "En attente de données MQTT…"}
        </div>
      ) : (
        <div className="relative">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis
                dataKey="ts"
                tick={{ fontSize: 10, fill: "#6b7280" }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#6b7280" }}
                domain={yDomain}
                label={yAxisLabel}
                width={unit ? 48 : 40}
              />
              {/* Zero reference line when unit is z_score or mad_score */}
              {(unit === "z_score" || unit === "mad_score") && (
                <ReferenceLine y={0} stroke="#374151" strokeDasharray="2 2" />
              )}
              <Tooltip
                contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151" }}
                labelStyle={{ color: "#9ca3af" }}
                formatter={tooltipFormatter}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#3b82f6"
                dot={false}
                strokeWidth={1.5}
                name="Valeur"
              />
              {hasMean && (
                <Line
                  type="monotone"
                  dataKey="mean"
                  stroke="#6b7280"
                  dot={false}
                  strokeWidth={1}
                  strokeDasharray="4 2"
                  name="Moyenne"
                />
              )}
              <Line
                type="monotone"
                dataKey="anomaly"
                stroke="#ef4444"
                dot={{ r: 4, fill: "#ef4444" }}
                strokeWidth={0}
                name="Anomalie"
              />
            </LineChart>
          </ResponsiveContainer>
          {!isConnected && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="text-xs text-gray-500 bg-gray-900/70 px-3 py-1 rounded">
                Capteur déconnecté
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
