/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */
"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "@/lib/api-client";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Port    { name: string; description: string }
interface Example { id: string; label: string; env: string; description: string }

type PortStatus = "scanning" | "detected" | "manual" | "disconnected";

// ── ESP32 examples catalogue ──────────────────────────────────────────────────

const EXAMPLES: Example[] = [
  { id: "zscore_demo",      label: "Z-Score Demo",       env: "esp32cam",       description: "Z-Score + Drift → MQTT Watch" },
  { id: "imu_zscore",       label: "IMU Z-Score",        env: "esp32cam",       description: "MPU-6050 accéléromètre → Z-Score → Watch" },
  { id: "fire_detection",   label: "Détection Feu",      env: "fire_detection", description: "OV2640 QQVGA RGB565 — 3×Z-Score" },
  { id: "person_detection", label: "Détection Personne", env: "person_detection", description: "VWW TFLite Micro + Z-Score → Watch MQTT" },
  { id: "smoke_test",       label: "Smoke Test",         env: "smoke",          description: "Test complet SDK — HAL + Z-Score + LED" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const POLL_MS = 2000; // port detection polling interval

/** Returns true if the port description looks like an ESP32 / CH340 adapter. */
function isEsp32Port(p: Port): boolean {
  const d = p.description.toLowerCase();
  return d.includes("ch340") || d.includes("ch341") || d.includes("usb-serial") ||
         d.includes("usb serial") || d.includes("cp210") || d.includes("ftdi") ||
         d.includes("espressif") || d.includes("uart");
}

function StatusDot({ state }: { state: "idle" | "running" | "ok" | "error" }) {
  if (state === "running") return <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse" />;
  if (state === "ok")      return <span className="inline-block w-2 h-2 rounded-full bg-green-400" />;
  if (state === "error")   return <span className="inline-block w-2 h-2 rounded-full bg-red-400" />;
  return                          <span className="inline-block w-2 h-2 rounded-full bg-gray-600" />;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function FlashPanel() {
  const [ports,       setPorts]       = useState<Port[]>([]);
  const [port,        setPort]        = useState("");          // selected port name
  const [portStatus,  setPortStatus]  = useState<PortStatus>("scanning");
  const [manualPort,  setManualPort]  = useState("");          // manual override text
  const [example,     setExample]     = useState<Example>(EXAMPLES[0]);
  const [flashStatus, setFlashStatus] = useState<"idle" | "running" | "ok" | "error">("idle");
  const [log,         setLog]         = useState("");

  const prevPortNames = useRef<Set<string>>(new Set());
  const logRef        = useRef<HTMLDivElement>(null);
  const esRef         = useRef<EventSource | null>(null);

  // Auto-scroll terminal
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // Poll COM ports every POLL_MS
  const pollPorts = useCallback(() => {
    apiFetch("/api/flash/ports")
      .then(async (r) => {
        if (!r.ok) return;
        const data: Port[] = await r.json();

        const prev = prevPortNames.current;
        const next = new Set(data.map((p) => p.name));

        // Find newly appeared ports
        const added = data.filter((p) => !prev.has(p.name));

        if (added.length > 0) {
          // Prefer ESP32-looking port; fallback to first added
          const best = added.find(isEsp32Port) ?? added[0];
          setPort(best.name);
          setPortStatus("detected");
        } else if (port && !next.has(port) && portStatus !== "manual") {
          // Previously selected port disappeared
          setPortStatus("disconnected");
        } else if (data.length === 0) {
          setPortStatus("scanning");
        } else if (portStatus === "scanning" && data.length > 0) {
          // First ever load — pick best candidate
          const best = data.find(isEsp32Port) ?? data[0];
          setPort(best.name);
          setPortStatus("detected");
        }

        setPorts(data);
        prevPortNames.current = next;
      })
      .catch(() => { /* ignore network errors during poll */ });
  }, [port, portStatus]);

  useEffect(() => {
    pollPorts(); // immediate first call
    const id = setInterval(pollPorts, POLL_MS);
    return () => clearInterval(id);
  }, [pollPorts]);

  // Manual override
  const applyManual = () => {
    const v = manualPort.trim().toUpperCase();
    if (!v) return;
    setPort(v);
    setPortStatus("manual");
    setManualPort("");
  };

  const effectivePort = port || manualPort;

  const handleFlash = async () => {
    if (flashStatus === "running" || !effectivePort) return;
    esRef.current?.close();
    setLog("");
    setFlashStatus("running");

    let res: Response;
    try {
      res = await apiFetch("/api/flash/start", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ env: example.env, project: example.id, port: effectivePort }),
      });
    } catch (err) {
      setLog(`Erreur réseau : ${err}`);
      setFlashStatus("error");
      return;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setLog(`Erreur : ${(err as { error?: string }).error ?? res.status}`);
      setFlashStatus("error");
      return;
    }

    const { jobId } = await res.json();
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
      setFlashStatus(code === 0 ? "ok" : "error");
      es.close();
    });

    es.onerror = () => {
      setFlashStatus((prev) => prev === "running" ? "error" : prev);
      es.close();
    };
  };

  // ── Port status badge ───────────────────────────────────────────────────────

  const portBadge = () => {
    if (portStatus === "scanning") {
      return (
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-pulse" />
          En attente de connexion…
        </span>
      );
    }
    if (portStatus === "disconnected") {
      return (
        <span className="flex items-center gap-1.5 text-[10px] text-amber-400">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          {port} — Déconnecté
        </span>
      );
    }
    if (portStatus === "manual") {
      return (
        <span className="flex items-center gap-1.5 text-[10px] text-gray-400">
          <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
          {port} — Override manuel
        </span>
      );
    }
    // detected
    const desc = ports.find((p) => p.name === port)?.description ?? "";
    const isEsp = isEsp32Port({ name: port, description: desc });
    return (
      <span className="flex items-center gap-1.5 text-[10px] text-green-400">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
        {port} — {isEsp ? "ESP32 / CH340 détecté" : "Détecté"}
      </span>
    );
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto space-y-4">

      {/* Header */}
      <div className="flex items-center gap-3">
        <StatusDot state={flashStatus} />
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
          Flash ESP32-CAM
        </h2>
        {flashStatus === "ok"    && <span className="text-xs text-green-400 font-mono">Flash réussi ✓</span>}
        {flashStatus === "error" && <span className="text-xs text-red-400 font-mono">Flash échoué</span>}
      </div>

      {/* Config */}
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
                  example.id === ex.id
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

          {/* Port detection */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">
                Port série
              </label>
              {portBadge()}
            </div>

            {/* Port list (shown when ports detected) */}
            {ports.length > 0 ? (
              <select
                value={port}
                onChange={(e) => { setPort(e.target.value); setPortStatus("detected"); }}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500"
              >
                {ports.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}{isEsp32Port(p) ? " ★" : ""} — {p.description}
                  </option>
                ))}
              </select>
            ) : (
              /* Scanning placeholder */
              <div className="w-full bg-gray-800/50 border border-dashed border-gray-700 rounded px-2.5 py-2 text-[11px] text-gray-600 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-gray-600 animate-pulse shrink-0" />
                Branchez le CH340 pour détecter automatiquement
              </div>
            )}

            {/* Manual override */}
            <div className="flex gap-1.5 mt-1.5">
              <input
                type="text"
                value={manualPort}
                onChange={(e) => setManualPort(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyManual()}
                placeholder="COM4 — override manuel"
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 placeholder-gray-600 outline-none focus:border-gray-500"
              />
              <button
                onClick={applyManual}
                disabled={!manualPort.trim()}
                className="px-2.5 py-1.5 rounded border border-gray-700 text-[11px] text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-30 transition-colors"
              >
                OK
              </button>
            </div>
            <p className="text-[9px] text-gray-600 mt-0.5">
              ★ = ESP32 / CH340 probable · Entrée ou OK pour forcer un port
            </p>
          </div>

          {/* Hardware reminder */}
          <div className="rounded border border-amber-700/30 bg-amber-900/10 px-3 py-2 text-[10px] text-amber-400 leading-relaxed">
            <b>Rappel :</b> utiliser <code>board=esp32dev</code>.
            Ouvrir le moniteur série <em>après</em> le flash.
          </div>

          {/* Launch */}
          <button
            onClick={handleFlash}
            disabled={flashStatus === "running" || !effectivePort}
            className={`w-full py-2.5 rounded font-semibold text-sm tracking-wide transition-colors disabled:opacity-50 ${
              flashStatus === "running"
                ? "bg-blue-700 text-white cursor-wait"
                : flashStatus === "ok"
                ? "bg-green-700 hover:bg-green-600 text-white"
                : "bg-blue-600 hover:bg-blue-500 text-white"
            }`}
          >
            {flashStatus === "running"
              ? "⟳ Flash en cours…"
              : effectivePort
              ? `⚡ Flasher sur ${effectivePort}`
              : "⚡ Compiler & Flasher"}
          </button>
        </div>
      </div>

      {/* Terminal */}
      {(log || flashStatus !== "idle") && (
        <div className="rounded-lg border border-gray-800 bg-gray-950 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
            <span className="text-[9px] font-mono uppercase tracking-widest text-gray-600">
              Sortie PlatformIO
            </span>
            <button
              onClick={() => { setLog(""); setFlashStatus("idle"); }}
              className="text-[9px] text-gray-700 hover:text-gray-400 transition-colors"
            >
              Effacer
            </button>
          </div>
          <div
            ref={logRef}
            className="p-3 font-mono text-[10px] text-gray-400 leading-relaxed max-h-80 overflow-y-auto whitespace-pre-wrap break-all"
          >
            {log || (flashStatus === "running" ? "Lancement…" : "")}
          </div>
        </div>
      )}
    </div>
  );
}
