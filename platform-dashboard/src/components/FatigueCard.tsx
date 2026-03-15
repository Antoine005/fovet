/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */
"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api-client";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  YAxis,
  ReferenceLine,
  Tooltip,
} from "recharts";

/* -------------------------------------------------------------------------
 * Thresholds — must match fovet/profiles/fatigue_profile.h
 * ------------------------------------------------------------------------- */
const HR_OK    = 72;   /* BPM < this → OK      */
const HR_ALERT = 82;   /* BPM > this → CRITICAL */
const EMA_ALPHA = 0.05;
const WARMUP_SAMPLES = 25;

export type FatigueLevel = "UNKNOWN" | "OK" | "ALERT" | "CRITICAL";

interface Reading {
  id: string;
  timestamp: string;
  value: number;
}

interface Props {
  deviceId: string;
  deviceName: string;
  location: string | null;
  selected?: boolean;
  onSelect: () => void;
}

const LEVEL_COLORS: Record<FatigueLevel, string> = {
  UNKNOWN:  "text-gray-500",
  OK:       "text-green-400",
  ALERT:    "text-amber-400",
  CRITICAL: "text-red-400",
};

const LEVEL_BORDER: Record<FatigueLevel, string> = {
  UNKNOWN:  "border-gray-800 bg-gray-900",
  OK:       "border-gray-800 bg-gray-900",
  ALERT:    "border-amber-800/50 bg-amber-950/10",
  CRITICAL: "border-red-800/60 bg-red-950/15",
};

const LEVEL_LABEL: Record<FatigueLevel, string> = {
  UNKNOWN:  "En attente",
  OK:       "Normal",
  ALERT:    "Élevé",
  CRITICAL: "Critique",
};

const LEVEL_DOT: Record<FatigueLevel, string> = {
  UNKNOWN:  "bg-gray-500",
  OK:       "bg-green-400",
  ALERT:    "bg-amber-400",
  CRITICAL: "bg-red-500 animate-pulse",
};

/** Compute fatigue level from EMA BPM using MCU thresholds. */
function classify(emaBpm: number, count: number): FatigueLevel {
  if (count < WARMUP_SAMPLES) return "UNKNOWN";
  if (emaBpm > HR_ALERT)      return "CRITICAL";
  if (emaBpm >= HR_OK)        return "ALERT";
  return "OK";
}

/** Compute EMA on an ordered array of BPM values. */
function computeEma(values: number[]): number {
  if (values.length === 0) return 0;
  let ema = values[0]; // seed
  for (let i = 1; i < values.length; i++) {
    ema = EMA_ALPHA * values[i] + (1 - EMA_ALPHA) * ema;
  }
  return ema;
}

const POLL_INTERVAL = 15_000;
const READINGS_LIMIT = 100;

export function FatigueCard({ deviceId, deviceName, location, selected, onSelect }: Props) {
  const [readings, setReadings] = useState<Reading[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    apiFetch(`/api/devices/${deviceId}/readings?limit=${READINGS_LIMIT}`)
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
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh]);

  const bpmValues = readings.map((r) => r.value);
  const emaBpm  = computeEma(bpmValues);
  const level   = classify(emaBpm, readings.length);
  const latest  = bpmValues.at(-1);

  const chartData = readings.map((r) => ({ bpm: r.value }));

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-xl border p-4 transition-colors cursor-pointer ${
        selected
          ? "ring-1 ring-blue-500 " + LEVEL_BORDER[level]
          : LEVEL_BORDER[level]
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <p className="font-semibold text-sm text-white truncate">{deviceName}</p>
          {location && (
            <p className="text-xs text-gray-500 truncate mt-0.5">{location}</p>
          )}
        </div>
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 mt-1 ${LEVEL_DOT[level]}`}
          title={LEVEL_LABEL[level]}
        />
      </div>

      {/* Level badge + BPM */}
      <div className="flex items-end justify-between mb-3">
        <div>
          <p className={`text-base font-bold font-mono ${LEVEL_COLORS[level]}`}>
            {LEVEL_LABEL[level]}
          </p>
          {level !== "UNKNOWN" && (
            <p className="text-xs text-gray-500 mt-0.5">
              EMA {emaBpm.toFixed(1)} bpm
            </p>
          )}
        </div>
        {latest !== undefined && (
          <p className="text-2xl font-bold font-mono text-white leading-none">
            {latest.toFixed(0)}
            <span className="text-xs text-gray-500 ml-1">bpm</span>
          </p>
        )}
      </div>

      {/* Sparkline */}
      {error ? (
        <div className="h-14 flex items-center justify-center text-red-400 text-xs">
          {error}
        </div>
      ) : readings.length === 0 ? (
        <div className="h-14 flex items-center justify-center text-gray-600 text-xs">
          En attente de données…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={56}>
          <LineChart data={chartData}>
            <YAxis hide domain={[40, 120]} />
            <ReferenceLine y={HR_OK}    stroke="#f59e0b" strokeDasharray="3 2" strokeWidth={1} />
            <ReferenceLine y={HR_ALERT} stroke="#ef4444" strokeDasharray="3 2" strokeWidth={1} />
            <Tooltip
              contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151", fontSize: 11 }}
              labelFormatter={() => ""}
              formatter={(v: number | undefined) => [v !== undefined ? `${v.toFixed(1)} bpm` : "", "BPM"]}
            />
            <Line
              type="monotone"
              dataKey="bpm"
              stroke="#3b82f6"
              dot={false}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}

      {/* Threshold legend */}
      <div className="flex items-center gap-3 mt-2">
        <span className="flex items-center gap-1 text-xs text-gray-600">
          <span className="w-3 border-t border-dashed border-amber-400/70" />
          {HR_OK} bpm
        </span>
        <span className="flex items-center gap-1 text-xs text-gray-600">
          <span className="w-3 border-t border-dashed border-red-400/70" />
          {HR_ALERT} bpm
        </span>
      </div>
    </button>
  );
}
