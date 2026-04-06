/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent-ai.fr
 */
"use client";

/**
 * LiveMonitor — global real-time reading stream (G6)
 *
 * Subscribes to GET /api/events (SSE), shows a live feed of readings
 * grouped by device with a mini sparkline, anomaly badges, and latency.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";

interface LiveReading {
  id: string;
  deviceId: string;
  channel: string | null;
  value: number;
  anomaly: boolean;
  zscore: number | null;
  algo: string | null;
  modelId: string | null;
  unit: string | null;
  label: string | null;
  timestamp: string;
  receivedAt: number; // Date.now() on arrival
}

interface DeviceState {
  deviceId: string;
  lastReading: LiveReading;
  history: number[];  // last 20 values for sparkline
  anomalyCount: number;
  totalCount: number;
}

const MAX_HISTORY = 20;
const MAX_FEED    = 100;

// ── Mini sparkline ─────────────────────────────────────────────────────────────

function Sparkline({ values, anomaly }: { values: number[]; anomaly: boolean }) {
  if (values.length < 2) return <div className="w-16 h-6" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 64; const H = 24;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = H - ((v - min) / range) * H;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={W} height={H} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={anomaly ? "#ef4444" : "#22d3ee"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Latency badge ──────────────────────────────────────────────────────────────

function LatencyBadge({ receivedAt, timestamp }: { receivedAt: number; timestamp: string }) {
  const latencyMs = receivedAt - new Date(timestamp).getTime();
  const color = latencyMs < 500 ? "text-green-400" : latencyMs < 2000 ? "text-yellow-400" : "text-red-400";
  return (
    <span className={`text-xs font-mono ${color}`}>
      {latencyMs > 0 ? `+${latencyMs}ms` : "—"}
    </span>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function LiveMonitor() {
  const [feed, setFeed]         = useState<LiveReading[]>([]);
  const [devices, setDevices]   = useState<Map<string, DeviceState>>(new Map());
  const [connected, setConnected] = useState(false);
  const [paused, setPaused]     = useState(false);
  const pausedRef               = useRef(false);
  const esRef                   = useRef<EventSource | null>(null);
  const feedRef                 = useRef<LiveReading[]>([]);

  pausedRef.current = paused;

  const onReading = useCallback((raw: string) => {
    if (pausedRef.current) return;
    const r = JSON.parse(raw) as Omit<LiveReading, "receivedAt">;
    const reading: LiveReading = { ...r, receivedAt: Date.now() };

    feedRef.current = [reading, ...feedRef.current].slice(0, MAX_FEED);
    setFeed([...feedRef.current]);

    setDevices((prev) => {
      const next = new Map(prev);
      const ds   = next.get(reading.deviceId);
      const hist = [...(ds?.history ?? []), reading.value].slice(-MAX_HISTORY);
      next.set(reading.deviceId, {
        deviceId:     reading.deviceId,
        lastReading:  reading,
        history:      hist,
        anomalyCount: (ds?.anomalyCount ?? 0) + (reading.anomaly ? 1 : 0),
        totalCount:   (ds?.totalCount ?? 0) + 1,
      });
      return next;
    });
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events", { withCredentials: true });
    esRef.current = es;

    es.addEventListener("open", () => setConnected(true));
    es.addEventListener("error", () => setConnected(false));
    es.addEventListener("reading", (e) => onReading((e as MessageEvent).data));

    return () => { es.close(); esRef.current = null; setConnected(false); };
  }, [onReading]);

  const deviceList = Array.from(devices.values()).sort(
    (a, b) => new Date(b.lastReading.timestamp).getTime() - new Date(a.lastReading.timestamp).getTime()
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-white">Live Monitor</h2>
          <span className={`flex items-center gap-1 text-xs ${connected ? "text-green-400" : "text-red-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-400" : "bg-red-500"}`} />
            {connected ? "Connecté" : "Déconnecté"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">{feed.length} lectures</span>
          <button
            onClick={() => setPaused((p) => !p)}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              paused ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
            }`}
          >
            {paused ? "▶ Reprendre" : "⏸ Pause"}
          </button>
          <button
            onClick={() => { setFeed([]); feedRef.current = []; setDevices(new Map()); }}
            className="px-2.5 py-1 rounded text-xs font-medium bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors"
          >
            Effacer
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: device cards */}
        <div className="w-72 shrink-0 border-r border-gray-800 overflow-y-auto p-3 flex flex-col gap-2">
          <p className="text-xs text-gray-500 px-1 pb-1">Appareils actifs</p>
          {deviceList.length === 0 && (
            <p className="text-xs text-gray-600 px-1">En attente de données MQTT…</p>
          )}
          {deviceList.map((ds) => (
            <div key={ds.deviceId} className="bg-gray-800/60 rounded-lg p-3 border border-gray-700/50">
              <div className="flex items-start justify-between mb-1.5">
                <div className="min-w-0">
                  <p className="text-xs font-mono text-gray-200 truncate">{ds.deviceId}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {ds.lastReading.channel ?? "—"} · {ds.lastReading.algo ?? "—"}
                  </p>
                </div>
                {ds.lastReading.anomaly ? (
                  <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/30 shrink-0">
                    ANOMALY
                  </span>
                ) : (
                  <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-500/10 text-green-400 border border-green-500/20 shrink-0">
                    NORMAL
                  </span>
                )}
              </div>
              <div className="flex items-end justify-between">
                <Sparkline values={ds.history} anomaly={ds.lastReading.anomaly} />
                <div className="text-right">
                  <p className="text-sm font-mono font-semibold text-white">
                    {ds.lastReading.value.toFixed(2)}
                    {ds.lastReading.unit ? <span className="text-xs text-gray-400 ml-0.5">{ds.lastReading.unit}</span> : null}
                  </p>
                  <p className="text-[10px] text-gray-500">
                    {ds.anomalyCount}/{ds.totalCount} anomalies
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Right: live feed */}
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-900 border-b border-gray-800 z-10">
              <tr>
                {["Heure", "Device", "Canal", "Valeur", "Z-Score", "Status", "Latence"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-gray-500 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {feed.map((r) => (
                <tr
                  key={`${r.id}-${r.receivedAt}`}
                  className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors ${
                    r.anomaly ? "bg-red-500/5" : ""
                  }`}
                >
                  <td className="px-3 py-1.5 font-mono text-gray-400 whitespace-nowrap">
                    {new Date(r.timestamp).toLocaleTimeString("fr-FR", { hour12: false })}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-gray-300 max-w-[120px] truncate">{r.deviceId}</td>
                  <td className="px-3 py-1.5 text-gray-400">{r.channel ?? "—"}</td>
                  <td className="px-3 py-1.5 font-mono font-semibold text-white">
                    {r.value.toFixed(3)}{r.unit ? <span className="text-gray-500 ml-0.5">{r.unit}</span> : null}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-gray-400">
                    {r.zscore != null ? r.zscore.toFixed(2) : "—"}
                  </td>
                  <td className="px-3 py-1.5">
                    {r.anomaly ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400">ANOMALY</span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-500/10 text-green-400">NORMAL</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <LatencyBadge receivedAt={r.receivedAt} timestamp={r.timestamp} />
                  </td>
                </tr>
              ))}
              {feed.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-gray-600">
                    En attente de données MQTT…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
