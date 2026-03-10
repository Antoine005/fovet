"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api-client";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
} from "recharts";
import { format } from "date-fns";
import { fr } from "date-fns/locale";

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

export function ReadingChart({ deviceId }: Props) {
  const [readings, setReadings] = useState<Reading[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchReadings = useCallback(() => {
    apiFetch(`/api/devices/${deviceId}/readings?limit=200`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Reading[]) => { setReadings(data); setError(null); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Erreur réseau"));
  }, [deviceId]);

  useEffect(() => {
    fetchReadings();
    const interval = setInterval(fetchReadings, 5000); // refresh every 5s
    return () => clearInterval(interval);
  }, [fetchReadings]);

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
          {readings.length} mesures — rafraîchissement 5s
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
