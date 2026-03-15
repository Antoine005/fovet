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
 * Thresholds — must match fovet/profiles/fatigue_profile.h
 * ------------------------------------------------------------------------- */
const HR_OK    = 72;
const HR_ALERT = 82;
const EMA_ALPHA = 0.05;
const MAX_READINGS = 200;
const SSE_MAX_RETRIES = 5;
const SSE_BASE_DELAY_MS = 1_000;
const SSE_MAX_DELAY_MS  = 30_000;

interface Reading {
  id: string;
  timestamp: string;
  value: number;
}

interface Props {
  deviceId: string;
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

export function HRVChart({ deviceId }: Props) {
  const [readings, setReadings] = useState<Reading[]>([]);
  const [error, setError]       = useState<string | null>(null);
  const [mode, setMode]         = useState<"sse" | "polling">("sse");
  const esRef          = useRef<EventSource | null>(null);
  const retryCountRef  = useRef(0);
  const retryTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef   = useRef(false);

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

  const bpmValues = readings.map((r) => r.value);
  const emaValues = applyEma(bpmValues);

  const chartData = readings.map((r, i) => ({
    ts:  format(new Date(r.timestamp), "HH:mm:ss", { locale: fr }),
    bpm: r.value,
    ema: emaValues[i],
  }));

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Fréquence cardiaque (BPM)</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            EMA α={EMA_ALPHA} — seuils Sentinelle Fatigue
          </p>
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="w-4 border-t-2 border-blue-400" />
            BPM brut
          </span>
          <span className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="w-4 border-t-2 border-dashed border-purple-400" />
            EMA
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

            {/* Zone coloring: OK (green), ALERT (amber), CRITICAL (red) */}
            <ReferenceArea y1={0}        y2={HR_OK}    fill="#16a34a" fillOpacity={0.04} />
            <ReferenceArea y1={HR_OK}    y2={HR_ALERT} fill="#f59e0b" fillOpacity={0.06} />
            <ReferenceArea y1={HR_ALERT} y2={200}      fill="#ef4444" fillOpacity={0.05} />

            {/* Threshold lines */}
            <ReferenceLine
              y={HR_OK}
              stroke="#f59e0b"
              strokeDasharray="5 3"
              strokeWidth={1}
              label={{ value: `OK ${HR_OK}`, position: "right", fontSize: 10, fill: "#f59e0b" }}
            />
            <ReferenceLine
              y={HR_ALERT}
              stroke="#ef4444"
              strokeDasharray="5 3"
              strokeWidth={1}
              label={{ value: `ALERTE ${HR_ALERT}`, position: "right", fontSize: 10, fill: "#ef4444" }}
            />

            <XAxis
              dataKey="ts"
              tick={{ fontSize: 10, fill: "#6b7280" }}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[40, 120]}
              tick={{ fontSize: 10, fill: "#6b7280" }}
              unit=" bpm"
            />
            <Tooltip
              contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151" }}
              labelStyle={{ color: "#9ca3af" }}
              formatter={(value: number | undefined, name: string | undefined) => [
                value !== undefined ? `${value.toFixed(1)} bpm` : "",
                name === "bpm" ? "BPM brut" : "EMA",
              ]}
            />

            <Line
              type="monotone"
              dataKey="bpm"
              stroke="#3b82f6"
              dot={false}
              strokeWidth={1.5}
              name="bpm"
            />
            <Line
              type="monotone"
              dataKey="ema"
              stroke="#a855f7"
              dot={false}
              strokeWidth={2}
              strokeDasharray="6 3"
              name="ema"
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* Level legend */}
      <div className="flex items-center gap-4 mt-3">
        <span className="flex items-center gap-1.5 text-xs text-green-500/80">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          Normal (&lt;{HR_OK} bpm)
        </span>
        <span className="flex items-center gap-1.5 text-xs text-amber-500/80">
          <span className="w-2 h-2 rounded-full bg-amber-500" />
          Élevé ({HR_OK}–{HR_ALERT} bpm)
        </span>
        <span className="flex items-center gap-1.5 text-xs text-red-500/80">
          <span className="w-2 h-2 rounded-full bg-red-500" />
          Critique (&gt;{HR_ALERT} bpm)
        </span>
      </div>
    </div>
  );
}
