/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */
"use client";

import React, { useState, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api-client";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Port     { name: string; description: string }
interface Example  { id: string; label: string; env: string; description: string }

// ── ESP32 examples catalogue ──────────────────────────────────────────────────

const EXAMPLES: Example[] = [
  { id: "zscore_demo",     label: "Z-Score Demo",      env: "esp32cam",      description: "Z-Score + Drift → MQTT Watch" },
  { id: "imu_zscore",      label: "IMU Z-Score",       env: "esp32cam",      description: "MPU-6050 accéléromètre → Z-Score → Watch" },
  { id: "fire_detection",  label: "Détection Feu",     env: "fire_detection",description: "OV2640 QQVGA RGB565 — 3×Z-Score" },
  { id: "person_detection",label: "Détection Personne",env: "person_detection",description: "VWW TFLite Micro + Z-Score → Watch MQTT" },
  { id: "smoke_test",      label: "Smoke Test",        env: "smoke",         description: "Test complet SDK — HAL + Z-Score + LED" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusDot({ state }: { state: "idle" | "running" | "ok" | "error" }) {
  if (state === "running") return <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse" />;
  if (state === "ok")      return <span className="inline-block w-2 h-2 rounded-full bg-green-400" />;
  if (state === "error")   return <span className="inline-block w-2 h-2 rounded-full bg-red-400" />;
  return <span className="inline-block w-2 h-2 rounded-full bg-gray-600" />;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function FlashPanel() {
  const [ports,       setPorts]       = useState<Port[]>([]);
  const [port,        setPort]        = useState("COM4");
  const [example,     setExample]     = useState<Example>(EXAMPLES[0]);
  const [status,      setStatus]      = useState<"idle" | "running" | "ok" | "error">("idle");
  const [log,         setLog]         = useState("");
  const [loadingPorts,setLoadingPorts]= useState(false);

  const logRef    = useRef<HTMLDivElement>(null);
  const esRef     = useRef<EventSource | null>(null);

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // Load COM ports on mount
  useEffect(() => {
    setLoadingPorts(true);
    apiFetch("/api/flash/ports")
      .then(async (r) => {
        if (!r.ok) return;
        const data: Port[] = await r.json();
        setPorts(data);
        if (data.length > 0) setPort(data[0].name);
      })
      .finally(() => setLoadingPorts(false));
  }, []);

  const refreshPorts = () => {
    setLoadingPorts(true);
    apiFetch("/api/flash/ports")
      .then(async (r) => {
        if (!r.ok) return;
        const data: Port[] = await r.json();
        setPorts(data);
      })
      .finally(() => setLoadingPorts(false));
  };

  const handleFlash = async () => {
    if (status === "running") return;

    // Close any previous SSE
    esRef.current?.close();
    setLog("");
    setStatus("running");

    let res: Response;
    try {
      res = await apiFetch("/api/flash/start", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ env: example.env, project: example.id, port }),
      });
    } catch (err) {
      setLog(`Erreur réseau : ${err}`);
      setStatus("error");
      return;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setLog(`Erreur : ${(err as { error?: string }).error ?? res.status}`);
      setStatus("error");
      return;
    }

    const { jobId } = await res.json();

    // Subscribe to SSE stream
    const es = new EventSource(`/api/flash/stream/${jobId}`);
    esRef.current = es;

    es.addEventListener("log", (e) => {
      try {
        const text: string = JSON.parse((e as MessageEvent).data);
        setLog((prev) => prev + text);
      } catch {
        setLog((prev) => prev + (e as MessageEvent).data);
      }
    });

    es.addEventListener("done", (e) => {
      const code = parseInt((e as MessageEvent).data, 10);
      setStatus(code === 0 ? "ok" : "error");
      es.close();
    });

    es.onerror = () => {
      setStatus((prev) => prev === "running" ? "error" : prev);
      es.close();
    };
  };

  const selEx = example;

  return (
    <div className="max-w-3xl mx-auto space-y-4">

      {/* Header */}
      <div className="flex items-center gap-3">
        <StatusDot state={status} />
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
          Flash ESP32-CAM
        </h2>
        {status === "ok"    && <span className="text-xs text-green-400 font-mono">Flash réussi ✓</span>}
        {status === "error" && <span className="text-xs text-red-400 font-mono">Flash échoué</span>}
      </div>

      {/* Config panel */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

        {/* Example selector */}
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-2">
            Exemple à flasher
          </label>
          <div className="space-y-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.id}
                onClick={() => setExample(ex)}
                className={`w-full text-left p-2.5 rounded border transition-all ${
                  selEx.id === ex.id
                    ? "border-blue-700/50 bg-blue-900/10"
                    : "border-gray-800 hover:border-gray-700 hover:bg-gray-800/40"
                }`}
              >
                <div className="text-[11px] font-semibold text-gray-100">{ex.label}</div>
                <div className="text-[9px] font-mono text-gray-500 mt-0.5">{ex.description}</div>
                <div className="text-[9px] font-mono text-gray-600 mt-0.5">env: {ex.env}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Port + launch */}
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 flex flex-col gap-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">
                Port série
              </label>
              <button
                onClick={refreshPorts}
                disabled={loadingPorts}
                className="text-[9px] text-gray-600 hover:text-gray-300 disabled:opacity-40 transition-colors"
              >
                {loadingPorts ? "…" : "⟳ Rafraîchir"}
              </button>
            </div>
            <select
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500"
            >
              {ports.length === 0 && <option value={port}>{port}</option>}
              {ports.map((p) => (
                <option key={p.name} value={p.name}>{p.name} — {p.description}</option>
              ))}
            </select>
            <input
              type="text"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="COM4"
              className="mt-1.5 w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 placeholder-gray-600 outline-none focus:border-blue-500"
            />
            <p className="text-[9px] text-gray-600 mt-1">Override manuel si non détecté</p>
          </div>

          {/* Hardware reminder */}
          <div className="rounded border border-amber-700/30 bg-amber-900/10 px-3 py-2 text-[10px] text-amber-400 leading-relaxed">
            <b>Rappel :</b> board=<code>esp32dev</code> — brancher CH340 sur {port} avant de lancer.
            Ouvrir le moniteur série <em>après</em> le flash.
          </div>

          {/* Launch button */}
          <button
            onClick={handleFlash}
            disabled={status === "running"}
            className={`w-full py-2.5 rounded font-semibold text-sm tracking-wide transition-colors disabled:opacity-50 ${
              status === "running"
                ? "bg-blue-700 text-white cursor-wait"
                : status === "ok"
                ? "bg-green-700 hover:bg-green-600 text-white"
                : "bg-blue-600 hover:bg-blue-500 text-white"
            }`}
          >
            {status === "running" ? "⟳ Flash en cours…" : "⚡ Compiler & Flasher"}
          </button>
        </div>
      </div>

      {/* Terminal output */}
      {(log || status !== "idle") && (
        <div className="rounded-lg border border-gray-800 bg-gray-950 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
            <span className="text-[9px] font-mono uppercase tracking-widest text-gray-600">
              Sortie PlatformIO
            </span>
            <button
              onClick={() => { setLog(""); setStatus("idle"); }}
              className="text-[9px] text-gray-700 hover:text-gray-400 transition-colors"
            >
              Effacer
            </button>
          </div>
          <div
            ref={logRef}
            className="p-3 font-mono text-[10px] text-gray-400 leading-relaxed max-h-80 overflow-y-auto whitespace-pre-wrap break-all"
          >
            {log || (status === "running" ? "Lancement…" : "")}
          </div>
        </div>
      )}
    </div>
  );
}
