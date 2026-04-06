/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent-ai.fr
 */
"use client";

/**
 * HistoryView — cross-device reading history with filters & CSV export (G8)
 *
 * Calls GET /api/readings with optional filters:
 *   deviceId, from, to, anomalyOnly
 * Exports via GET /api/readings/export?... (browser download).
 */

import React, { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api-client";

interface Reading {
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
}

interface Pagination {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

interface Device {
  id: string;
  name: string;
  mqttClientId: string;
}

export default function HistoryView() {
  const [readings, setReadings]   = useState<Reading[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading]     = useState(false);
  const [devices, setDevices]     = useState<Device[]>([]);

  // Filters
  const [deviceId, setDeviceId]       = useState("");
  const [from, setFrom]               = useState("");
  const [to, setTo]                   = useState("");
  const [anomalyOnly, setAnomalyOnly] = useState(false);

  // Pagination
  const [cursor, setCursor] = useState<string | null>(null);

  const buildQS = useCallback((extraCursor?: string | null) => {
    const p = new URLSearchParams();
    if (deviceId)   p.set("deviceId", deviceId);
    if (from)       p.set("from", new Date(from).toISOString());
    if (to)         p.set("to",   new Date(to).toISOString());
    if (anomalyOnly) p.set("anomalyOnly", "1");
    if (extraCursor) p.set("cursor", extraCursor);
    return p.toString();
  }, [deviceId, from, to, anomalyOnly]);

  const fetchReadings = useCallback(async (append = false) => {
    setLoading(true);
    try {
      const qs  = buildQS(append ? cursor : null);
      const res = await apiFetch(`/api/readings?${qs}`);
      if (!res.ok) return;
      const json = await res.json() as { data: Reading[]; pagination: Pagination };
      setReadings((prev) => append ? [...prev, ...json.data] : json.data);
      setPagination(json.pagination);
      if (!append) setCursor(null);
    } finally {
      setLoading(false);
    }
  }, [buildQS, cursor]);

  useEffect(() => {
    apiFetch("/api/devices").then(async (r) => {
      if (r.ok) setDevices(await r.json() as Device[]);
    });
  }, []);

  useEffect(() => {
    fetchReadings(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // initial load only

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setCursor(null);
    fetchReadings(false);
  };

  const handleLoadMore = () => {
    if (!pagination?.nextCursor) return;
    setCursor(pagination.nextCursor);
    fetchReadings(true);
  };

  const handleExport = () => {
    const qs = buildQS();
    window.open(`/api/readings/export?${qs}`, "_blank");
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-800 shrink-0">
        <h2 className="text-sm font-semibold text-white">Historique des lectures</h2>
        <button
          onClick={handleExport}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 transition-colors"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path d="M8 2v8M5 7l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2 12h12" strokeLinecap="round" />
          </svg>
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <form onSubmit={handleSearch} className="flex flex-wrap items-end gap-3 px-6 py-3 border-b border-gray-800 shrink-0">
        {/* Device */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-gray-500 uppercase tracking-wider">Appareil</label>
          <select
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-gray-600"
          >
            <option value="">Tous</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>

        {/* From */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-gray-500 uppercase tracking-wider">Depuis</label>
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-gray-600"
          />
        </div>

        {/* To */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-gray-500 uppercase tracking-wider">Jusqu{"'"}à</label>
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-gray-600"
          />
        </div>

        {/* Anomaly only */}
        <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer pb-1.5">
          <input
            type="checkbox"
            checked={anomalyOnly}
            onChange={(e) => setAnomalyOnly(e.target.checked)}
            className="w-3.5 h-3.5 accent-red-500"
          />
          Anomalies seulement
        </label>

        <button
          type="submit"
          disabled={loading}
          className="px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 disabled:opacity-50 text-xs text-white font-medium transition-colors"
        >
          {loading ? "…" : "Rechercher"}
        </button>

        {readings.length > 0 && (
          <span className="text-xs text-gray-500 pb-1.5">{readings.length} résultat{readings.length > 1 ? "s" : ""}</span>
        )}
      </form>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-gray-900 border-b border-gray-800 z-10">
            <tr>
              {["Horodatage", "Appareil", "Canal", "Valeur", "Z-Score", "Algo", "Status"].map((h) => (
                <th key={h} className="px-3 py-2 text-left text-gray-500 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {readings.map((r) => (
              <tr
                key={r.id}
                className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors ${
                  r.anomaly ? "bg-red-500/5" : ""
                }`}
              >
                <td className="px-3 py-1.5 font-mono text-gray-400 whitespace-nowrap">
                  {new Date(r.timestamp).toLocaleString("fr-FR")}
                </td>
                <td className="px-3 py-1.5 font-mono text-gray-300 max-w-[140px] truncate">{r.deviceId}</td>
                <td className="px-3 py-1.5 text-gray-400">{r.channel ?? "—"}</td>
                <td className="px-3 py-1.5 font-mono font-semibold text-white">
                  {r.value.toFixed(3)}
                  {r.unit && <span className="text-gray-500 ml-0.5">{r.unit}</span>}
                </td>
                <td className="px-3 py-1.5 font-mono text-gray-400">
                  {r.zscore != null ? r.zscore.toFixed(2) : "—"}
                </td>
                <td className="px-3 py-1.5 text-gray-500">{r.algo ?? "—"}</td>
                <td className="px-3 py-1.5">
                  {r.anomaly ? (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400">ANOMALY</span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-500/10 text-green-400">NORMAL</span>
                  )}
                </td>
              </tr>
            ))}
            {!loading && readings.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-gray-600">
                  Aucune lecture trouvée
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Load more */}
        {pagination?.hasMore && (
          <div className="flex justify-center py-4">
            <button
              onClick={handleLoadMore}
              disabled={loading}
              className="px-4 py-2 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-xs text-gray-300 transition-colors"
            >
              {loading ? "Chargement…" : "Charger plus"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
