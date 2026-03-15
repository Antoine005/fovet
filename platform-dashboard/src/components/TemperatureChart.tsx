/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */
"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { apiFetch } from "@/lib/api-client";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  ReferenceArea,
} from "recharts";
import { format } from "date-fns";
import { fr } from "date-fns/locale";

/* -------------------------------------------------------------------------
 * Thresholds — must match temp_profile.h (H3.3)
 * ------------------------------------------------------------------------- */
const WBGT_WARN_C    = 25;
const WBGT_DANGER_C  = 28;
const COLD_ALERT_C   = 10;
const EMA_ALPHA      = 0.10;
const MAX_READINGS   = 200;
const SSE_MAX_RETRIES    = 5;
const SSE_BASE_DELAY_MS  = 1_000;
const SSE_MAX_DELAY_MS   = 30_000;

interface Reading {
  id: string;
  timestamp: string;
  value: number;    /* celsius */
  value2?: number;  /* humidity_pct */
}

interface Props {
  deviceId: string;
}

/** Stull (2011) indoor WBGT — mirrors C implementation in temp_profile.c. */
function computeWbgt(celsius: number, humidityPct: number): number {
  const t = celsius;
  const h = humidityPct;
  const nwb =
    t * Math.atan(0.151977 * Math.sqrt(h + 8.313659)) +
    Math.atan(t + h) -
    Math.atan(h - 1.676331) +
    0.00391838 * Math.pow(h, 1.5) * Math.atan(0.023101 * h) -
    4.686035;
  return 0.7 * nwb + 0.3 * t;
}

/** One-pass EMA for display — applied to a full readings array. */
function applyEma(values: number[]): number[] {
  const result: number[] = [];
  let ema = values[0] ?? 0;
  for (const v of values) {
    ema = EMA_ALPHA * v + (1 - EMA_ALPHA) * ema;
    result.push(ema);
  }
  return result;
}

export function TemperatureChart({ deviceId }: Props) {
  const [readings, setReadings] = useState<Reading[]>([]);
  const [error, setError]       = useState<string | null>(null);
  const [mode, setMode]         = useState<"sse" | "polling">("sse");
  const esRef         = useRef<EventSource | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef  = useRef(false);

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
        return r.json() as Promise<{ data: Reading[] }>;
      })
      .then((env) => {
        setReadings(env.data);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Erreur réseau")
      );
  }, [deviceId]);

  useEffect(() => {
    unmountedRef.current = false;
    retryCountRef.current = 0;
    fetchInitial();

    function connectSSE() {
      if (unmountedRef.current) return;
      const es = new EventSource(`/api/devices/${deviceId}/stream`);
      esRef.current = es;
      setMode("sse");

      es.addEventListener("reading", (e: MessageEvent) => {
        try {
          appendReading(JSON.parse(e.data) as Reading);
          setError(null);
          retryCountRef.current = 0;
        } catch { /* ignore parse errors */ }
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (unmountedRef.current) return;
        retryCountRef.current += 1;
        if (retryCountRef.current >= SSE_MAX_RETRIES) { setMode("polling"); return; }
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
      if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [deviceId, fetchInitial, appendReading]);

  useEffect(() => {
    if (mode !== "polling") return;
    const interval = setInterval(fetchInitial, 5_000);
    return () => clearInterval(interval);
  }, [mode, fetchInitial]);

  const celsiusValues  = readings.map((r) => r.value);
  const humidityValues = readings.map((r) => r.value2 ?? 50);
  const emaValues      = applyEma(celsiusValues);

  const chartData = readings.map((r, i) => {
    const h = humidityValues[i];
    return {
      ts:      format(new Date(r.timestamp), "HH:mm:ss", { locale: fr }),
      celsius: r.value,
      ema:     emaValues[i],
      wbgt:    computeWbgt(r.value, h),
    };
  });

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Température ambiante (DHT22)</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            EMA α={EMA_ALPHA} — WBGT Stull (2011) — Sentinelle H3.3
          </p>
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="w-4 border-t-2 border-orange-400" />
            Temp. brute
          </span>
          <span className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="w-4 border-t-2 border-dashed border-orange-300" />
            EMA
          </span>
          <span className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="w-4 border-t-2 border-teal-400" />
            WBGT
          </span>
          <span className="text-xs text-gray-500 font-mono">
            {readings.length} mesures —{" "}
            {mode === "sse" ? "temps réel (SSE)" : "rafraîchissement 5s"}
          </span>
        </div>
      </div>

      {error ? (
        <div className="h-56 flex items-center justify-center text-red-400 text-sm">
          {error}
        </div>
      ) : readings.length === 0 ? (
        <div className="h-56 flex items-center justify-center text-gray-600 text-sm">
          En attente de données MQTT…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />

            {/* Zone coloring */}
            <ReferenceArea y1={-15}         y2={COLD_ALERT_C}  fill="#60a5fa" fillOpacity={0.05} />
            <ReferenceArea y1={COLD_ALERT_C} y2={WBGT_WARN_C}  fill="#16a34a" fillOpacity={0.03} />
            <ReferenceArea y1={WBGT_WARN_C}  y2={WBGT_DANGER_C} fill="#f59e0b" fillOpacity={0.05} />
            <ReferenceArea y1={WBGT_DANGER_C} y2={50}           fill="#ef4444" fillOpacity={0.05} />

            {/* Threshold lines */}
            <ReferenceLine
              y={COLD_ALERT_C}
              stroke="#60a5fa"
              strokeDasharray="5 3"
              strokeWidth={1}
              label={{ value: `Froid ${COLD_ALERT_C}°C`, position: "right", fontSize: 10, fill: "#60a5fa" }}
            />
            <ReferenceLine
              y={WBGT_WARN_C}
              stroke="#f59e0b"
              strokeDasharray="5 3"
              strokeWidth={1}
              label={{ value: `WBGT ${WBGT_WARN_C}`, position: "right", fontSize: 10, fill: "#f59e0b" }}
            />
            <ReferenceLine
              y={WBGT_DANGER_C}
              stroke="#ef4444"
              strokeDasharray="5 3"
              strokeWidth={1}
              label={{ value: `WBGT ${WBGT_DANGER_C}`, position: "right", fontSize: 10, fill: "#ef4444" }}
            />

            <XAxis
              dataKey="ts"
              tick={{ fontSize: 10, fill: "#6b7280" }}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[-5, 45]}
              tick={{ fontSize: 10, fill: "#6b7280" }}
              unit=" °C"
            />
            <Tooltip
              contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151" }}
              labelStyle={{ color: "#9ca3af" }}
              formatter={(value: number | undefined, name: string | undefined) => {
                const v = value !== undefined ? value.toFixed(1) : "–";
                if (name === "celsius") return [`${v} °C`, "Temp. brute"];
                if (name === "ema")     return [`${v} °C`, "EMA"];
                if (name === "wbgt")    return [`${v} °C`, "WBGT"];
                return [v, name ?? ""];
              }}
            />

            <Line
              type="monotone"
              dataKey="celsius"
              stroke="#f97316"
              dot={false}
              strokeWidth={1.5}
              name="celsius"
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="ema"
              stroke="#fed7aa"
              dot={false}
              strokeWidth={2}
              strokeDasharray="6 3"
              name="ema"
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="wbgt"
              stroke="#2dd4bf"
              dot={false}
              strokeWidth={1.5}
              name="wbgt"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* Level legend */}
      <div className="flex items-center gap-4 mt-3 flex-wrap">
        <span className="flex items-center gap-1.5 text-xs text-blue-400/80">
          <span className="w-2 h-2 rounded-full bg-blue-400" />
          Froid (&lt;{COLD_ALERT_C} °C)
        </span>
        <span className="flex items-center gap-1.5 text-xs text-green-500/80">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          Normal
        </span>
        <span className="flex items-center gap-1.5 text-xs text-amber-500/80">
          <span className="w-2 h-2 rounded-full bg-amber-500" />
          Chaleur (WBGT {WBGT_WARN_C}–{WBGT_DANGER_C} °C)
        </span>
        <span className="flex items-center gap-1.5 text-xs text-red-500/80">
          <span className="w-2 h-2 rounded-full bg-red-500" />
          Stress thermique (WBGT &gt;{WBGT_DANGER_C} °C)
        </span>
      </div>
    </div>
  );
}
