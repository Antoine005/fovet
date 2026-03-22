"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api-client";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  YAxis,
  Tooltip,
} from "recharts";

interface Reading {
  id: string;
  timestamp: string;
  value: number;
  isAnomaly: boolean;
}

interface AlertsEnvelope {
  data: unknown[];
  pagination: { hasMore: boolean };
}

interface Props {
  deviceId: string;
  deviceName: string;
  mqttClientId: string;
  location: string | null;
  onSelect: () => void;
}

const POLL_INTERVAL = 15_000;
const READINGS_LIMIT = 60;
const ALERTS_LIMIT = 20;
const CONNECTED_THRESHOLD_MS = 30_000;

export function FleetPanel({ deviceId, deviceName, mqttClientId, location, onSelect }: Props) {
  const [readings, setReadings] = useState<Reading[]>([]);
  const [alertCount, setAlertCount] = useState(0);
  const [alertsHasMore, setAlertsHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    Promise.all([
      apiFetch(`/api/devices/${deviceId}/readings?limit=${READINGS_LIMIT}`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<{ data: Reading[] }>;
        })
        .then((env) => setReadings(env.data)),
      apiFetch(`/api/devices/${deviceId}/alerts?limit=${ALERTS_LIMIT}`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<AlertsEnvelope>;
        })
        .then((env) => {
          setAlertCount(env.data.length);
          setAlertsHasMore(env.pagination.hasMore);
        }),
    ])
      .then(() => setError(null))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Erreur réseau")
      );
  }, [deviceId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [refresh]);

  const chartData = readings.map((r) => ({
    value: r.value,
    anomaly: r.isAnomaly ? r.value : null,
  }));
  const hasAlerts = alertCount > 0 || alertsHasMore;
  const latestValue = readings.at(-1)?.value;
  const latestTimestamp = readings.at(-1)?.timestamp;
  const isConnected =
    latestTimestamp !== undefined &&
    Date.now() - new Date(latestTimestamp).getTime() < CONNECTED_THRESHOLD_MS;

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-xl border p-3 transition-colors cursor-pointer ${
        hasAlerts
          ? "border-red-900/60 bg-red-950/10 hover:border-red-700/60"
          : "border-gray-800 bg-gray-900 hover:border-gray-600"
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium text-sm text-white truncate max-w-[65%]">
          {deviceName}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {hasAlerts && (
            <span className="text-xs bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded-full font-mono">
              {alertCount}{alertsHasMore ? "+" : ""}
            </span>
          )}
          <span
            className={`w-2 h-2 rounded-full ${
              latestTimestamp === undefined
                ? "bg-gray-600"
                : isConnected
                  ? "bg-green-400"
                  : "bg-red-500"
            }`}
            title={latestTimestamp === undefined ? "Aucune donnée" : isConnected ? "Connecté" : "Déconnecté"}
          />
        </div>
      </div>
      <p className="text-xs text-gray-500 font-mono truncate mb-2">{mqttClientId}</p>
      {location && (
        <p className="text-xs text-gray-600 mb-2 truncate">{location}</p>
      )}

      {/* Sparkline */}
      {error ? (
        <div className="h-16 flex items-center justify-center text-red-400 text-xs">
          {error}
        </div>
      ) : readings.length === 0 ? (
        <div className="h-16 flex items-center justify-center text-gray-600 text-xs">
          En attente…
        </div>
      ) : (
        <div className="relative">
          <ResponsiveContainer width="100%" height={64}>
            <LineChart data={chartData}>
              <YAxis hide domain={["auto", "auto"]} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#111827",
                  border: "1px solid #374151",
                  fontSize: 11,
                }}
                labelFormatter={() => ""}
                formatter={(v: number | undefined) => [
                  v !== undefined ? v.toFixed(4) : "",
                  "val",
                ]}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#3b82f6"
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="anomaly"
                stroke="#ef4444"
                dot={{ r: 3, fill: "#ef4444" }}
                strokeWidth={0}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
          {latestValue !== undefined && (
            <span className="absolute bottom-0 right-0 text-xs font-mono text-gray-600">
              {latestValue.toFixed(4)}
            </span>
          )}
        </div>
      )}
    </button>
  );
}
