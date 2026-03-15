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
} from "recharts";
import { format } from "date-fns";
import { fr } from "date-fns/locale";

const MAX_READINGS = 200;

interface Reading {
  id: string;
  timestamp: string;
  value: number;
  mean: number;
  stddev: number;
  zScore: number;
  isAnomaly: boolean;
}

interface Props {
  deviceId: string;
}

const SSE_MAX_RETRIES = 5;
const SSE_BASE_DELAY_MS = 1_000;
const SSE_MAX_DELAY_MS = 30_000;

export function ReadingChart({ deviceId }: Props) {
  const [readings, setReadings] = useState<Reading[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"sse" | "polling">("sse");
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

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
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Erreur réseau")
      );
  }, [deviceId]);

  // SSE connection with exponential backoff — falls back to polling after
  // SSE_MAX_RETRIES consecutive failures.
  useEffect(() => {
    unmountedRef.current = false;
    retryCountRef.current = 0;
    fetchInitial();

    function connectSSE() {
      if (unmountedRef.current) return;

      const es = new EventSource(`/api/devices/${deviceId}/stream`);
      eventSourceRef.current = es;
      setMode("sse");

      es.addEventListener("reading", (e: MessageEvent) => {
        try {
          appendReading(JSON.parse(e.data) as Reading);
          setError(null);
          retryCountRef.current = 0; // reset on successful message
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

  const chartData = readings.map((r) => ({
    ts: format(new Date(r.timestamp), "HH:mm:ss", { locale: fr }),
    value: r.value,
    mean: r.mean,
    anomaly: r.isAnomaly ? r.value : null,
  }));

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-white">Signal capteur</h2>
        <span className="text-xs text-gray-500">
          {readings.length} mesures —{" "}
          {mode === "sse" ? "temps réel (SSE)" : "rafraîchissement 5s"}
        </span>
      </div>

      {error ? (
        <div className="h-48 flex items-center justify-center text-red-400 text-sm">
          {error}
        </div>
      ) : readings.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-gray-600 text-sm">
          En attente de données MQTT…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis
              dataKey="ts"
              tick={{ fontSize: 10, fill: "#6b7280" }}
              interval="preserveStartEnd"
            />
            <YAxis tick={{ fontSize: 10, fill: "#6b7280" }} />
            <Tooltip
              contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151" }}
              labelStyle={{ color: "#9ca3af" }}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="#3b82f6"
              dot={false}
              strokeWidth={1.5}
              name="Valeur"
            />
            <Line
              type="monotone"
              dataKey="mean"
              stroke="#6b7280"
              dot={false}
              strokeWidth={1}
              strokeDasharray="4 2"
              name="Moyenne"
            />
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
      )}
    </div>
  );
}
