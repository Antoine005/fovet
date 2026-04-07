/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent-ai.fr
 */
"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "@/lib/api-client";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Port { name: string; description: string }

type PortStatus = "scanning" | "detected" | "manual" | "disconnected";
type Sensor     = "ov2640" | "mpu6050" | "max30102" | "dht22";
type Compat     = "recommended" | "compatible" | "incompatible";

interface Example {
  id:              string;
  label:           string;
  env:             string;
  description:     string;
  requiredSensors: Sensor[];   // all must be present → recommended
  warnIfMissing:   Sensor[];   // missing → yellow warning, but not blocked
}

// ── Catalogue (loaded dynamically from /api/flash/examples) ──────────────────

// Fallback shown while loading
const EXAMPLES_FALLBACK: Example[] = [
  { id: "zscore_demo", label: "Z-Score Demo", env: "esp32cam",
    description: "Signal synthétique → Z-Score + Drift → Watch MQTT",
    requiredSensors: [], warnIfMissing: [] },
];

// ── Sensor metadata ───────────────────────────────────────────────────────────

const SENSORS: { id: Sensor; label: string; icon: string; hint: string }[] = [
  { id: "ov2640",  label: "OV2640",   icon: "🎥", hint: "Caméra intégrée ESP32-CAM" },
  { id: "mpu6050", label: "MPU-6050", icon: "📡", hint: "Accéléromètre I2C SDA=GPIO13, SCL=GPIO14" },
  { id: "max30102",label: "MAX30102", icon: "❤️", hint: "Capteur HR/SpO₂ I2C" },
  { id: "dht22",   label: "DHT22",    icon: "🌡️", hint: "Température + Humidité" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const POLL_MS     = 2000;
const LS_SENSORS  = "ardent_flash_sensors";

function isEsp32Port(p: Port): boolean {
  const d = p.description.toLowerCase();
  return d.includes("ch340") || d.includes("ch341") || d.includes("usb-serial") ||
         d.includes("usb serial") || d.includes("cp210") || d.includes("ftdi") ||
         d.includes("espressif") || d.includes("uart");
}

function getCompat(ex: Example, selected: Set<Sensor>): Compat {
  if (ex.requiredSensors.length === 0) return "compatible";
  const allPresent = ex.requiredSensors.every((s) => selected.has(s));
  return allPresent ? "recommended" : "incompatible";
}

function sortedExamples(list: Example[], selected: Set<Sensor>): (Example & { compat: Compat })[] {
  const ranked = list.map((ex) => ({ ...ex, compat: getCompat(ex, selected) }));
  const order: Record<Compat, number> = { recommended: 0, compatible: 1, incompatible: 2 };
  return ranked.sort((a, b) => order[a.compat] - order[b.compat]);
}

function loadSavedSensors(): Set<Sensor> {
  try {
    const raw = localStorage.getItem(LS_SENSORS);
    if (raw) return new Set(JSON.parse(raw) as Sensor[]);
  } catch { /* ignore */ }
  return new Set();
}

function StatusDot({ state }: { state: "idle" | "running" | "ok" | "error" }) {
  if (state === "running") return <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse" />;
  if (state === "ok")      return <span className="inline-block w-2 h-2 rounded-full bg-green-400" />;
  if (state === "error")   return <span className="inline-block w-2 h-2 rounded-full bg-red-400" />;
  return                          <span className="inline-block w-2 h-2 rounded-full bg-gray-600" />;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface FlashPanelProps {
  preselectedPort?: string;
}

export default function FlashPanel({ preselectedPort }: FlashPanelProps) {
  const [ports,        setPorts]        = useState<Port[]>([]);
  const [port,         setPort]         = useState(preselectedPort ?? "");
  const [portStatus,   setPortStatus]   = useState<PortStatus>(preselectedPort ? "detected" : "scanning");
  const [manualPort,   setManualPort]   = useState("");
  const [sensors,      setSensors]      = useState<Set<Sensor>>(new Set());
  const [examples,     setExamples]     = useState<Example[]>(EXAMPLES_FALLBACK);
  const [example,      setExample]      = useState<Example>(EXAMPLES_FALLBACK[0]);
  const [flashStatus,  setFlashStatus]  = useState<"idle" | "running" | "ok" | "error">("idle");
  const [cleanBuild,   setCleanBuild]   = useState(false);
  const [log,          setLog]          = useState("");
  const [historyHint,  setHistoryHint]  = useState<string | null>(null); // last firmware from DB

  const prevPortNames = useRef<Set<string>>(new Set());
  const logRef        = useRef<HTMLDivElement>(null);
  const esRef         = useRef<EventSource | null>(null);

  // Auto-scroll terminal
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // Load saved sensors from localStorage on mount
  useEffect(() => {
    setSensors(loadSavedSensors());
  }, []);

  // Load example catalogue from API (dynamic — no code change needed to add examples)
  useEffect(() => {
    apiFetch("/api/flash/examples")
      .then(async (r) => {
        if (!r.ok) return;
        const data = await r.json() as Example[];
        if (data.length > 0) {
          setExamples(data);
          setExample((prev) => data.find((e) => e.id === prev.id) ?? data[0]);
        }
      })
      .catch(() => {});
  }, []);

  // Sync preselectedPort
  useEffect(() => {
    if (preselectedPort) { setPort(preselectedPort); setPortStatus("detected"); }
  }, [preselectedPort]);

  // Fetch last firmware from DB — suggest the matching example
  useEffect(() => {
    apiFetch("/api/readings?limit=1")
      .then(async (r) => {
        if (!r.ok) return;
        const json = await r.json() as { data: { algo: string | null }[] };
        const lastFw = json.data[0]?.algo ?? null;
        if (!lastFw) return;
        setHistoryHint(lastFw);
        // Only auto-select if user hasn't manually changed from the default
        const match = examples.find((e) => e.id === lastFw);
        if (match) setExample(match);
      })
      .catch(() => {});
  }, []);

  // Poll COM ports every POLL_MS
  const pollPorts = useCallback(() => {
    apiFetch("/api/flash/ports")
      .then(async (r) => {
        if (!r.ok) return;
        const data: Port[] = await r.json();
        const prev = prevPortNames.current;
        const next = new Set(data.map((p) => p.name));

        const added = data.filter((p) => !prev.has(p.name));

        if (added.length > 0) {
          const best = added.find(isEsp32Port) ?? added[0];
          setPort(best.name);
          setPortStatus("detected");
        } else if (port && !next.has(port) && portStatus !== "manual") {
          setPortStatus("disconnected");
        } else if (data.length === 0) {
          setPortStatus("scanning");
        } else if (portStatus === "scanning" && data.length > 0) {
          const best = data.find(isEsp32Port) ?? data[0];
          setPort(best.name);
          setPortStatus("detected");
        }

        setPorts(data);
        prevPortNames.current = next;
      })
      .catch(() => {});
  }, [port, portStatus]);

  useEffect(() => {
    pollPorts();
    const id = setInterval(pollPorts, POLL_MS);
    return () => clearInterval(id);
  }, [pollPorts]);

  // Toggle sensor + persist
  const toggleSensor = (s: Sensor) => {
    setSensors((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      try { localStorage.setItem(LS_SENSORS, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  const applyManual = () => {
    const v = manualPort.trim().toUpperCase();
    if (!v) return;
    setPort(v); setPortStatus("manual"); setManualPort("");
  };

  const effectivePort = port || manualPort;

  const handleFlash = async () => {
    if (flashStatus === "running" || !effectivePort) return;
    esRef.current?.close();
    setLog(""); setFlashStatus("running");

    // Clean build: delete .pio/build/<env> before compiling
    if (cleanBuild) {
      setLog("[ardent] Suppression du cache de compilation (.pio/build)…\n");
      try {
        const cleanRes = await apiFetch("/api/flash/clean", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ env: example.env, project: example.id }),
        });
        const cleanData = await cleanRes.json() as { ok: boolean; reason?: string; deleted?: string };
        if (cleanData.ok) {
          setLog((p) => p + `[ardent] Cache supprimé : ${cleanData.deleted ?? ""}\n\n`);
        } else {
          setLog((p) => p + `[ardent] Aucun cache trouvé (${cleanData.reason ?? "not_found"}) — compilation complète de toute façon.\n\n`);
        }
      } catch {
        setLog((p) => p + "[ardent] Avertissement : impossible de nettoyer le cache, flash quand même.\n\n");
      }
    }

    let res: Response;
    try {
      res = await apiFetch("/api/flash/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env: example.env, project: example.id, port: effectivePort }),
      });
    } catch (err) {
      setLog((p) => p + `Erreur réseau : ${err}`); setFlashStatus("error"); return;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setLog(`Erreur : ${(err as { error?: string }).error ?? res.status}`);
      setFlashStatus("error"); return;
    }

    const { jobId } = await res.json();
    const es = new EventSource(`/api/flash/stream/${jobId}`);
    esRef.current = es;

    es.addEventListener("log", (e) => {
      try { setLog((p) => p + (JSON.parse((e as MessageEvent).data) as string)); }
      catch { setLog((p) => p + (e as MessageEvent).data); }
    });
    es.addEventListener("done", (e) => {
      setFlashStatus(parseInt((e as MessageEvent).data, 10) === 0 ? "ok" : "error");
      es.close();
    });
    es.onerror = () => { setFlashStatus((p) => p === "running" ? "error" : p); es.close(); };
  };

  // ── Port badge ────────────────────────────────────────────────────────────────

  const portBadge = () => {
    if (portStatus === "scanning")
      return <span className="flex items-center gap-1.5 text-[10px] text-gray-500"><span className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-pulse" />En attente…</span>;
    if (portStatus === "disconnected")
      return <span className="flex items-center gap-1.5 text-[10px] text-amber-400"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" />{port} — Déconnecté</span>;
    if (portStatus === "manual")
      return <span className="flex items-center gap-1.5 text-[10px] text-gray-400"><span className="w-1.5 h-1.5 rounded-full bg-gray-400" />{port} — Override manuel</span>;
    const desc  = ports.find((p) => p.name === port)?.description ?? "";
    const isEsp = isEsp32Port({ name: port, description: desc });
    return (
      <span className="flex items-center gap-1.5 text-[10px] text-green-400">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
        {port} — {isEsp ? "ESP32 / CH340 détecté" : "Détecté"}
      </span>
    );
  };

  // ── Sorted example list ────────────────────────────────────────────────────

  const ranked = sortedExamples(examples, sensors);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto space-y-4">

      {/* Header */}
      <div className="flex items-center gap-3">
        <StatusDot state={flashStatus} />
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Flash ESP32-CAM</h2>
        {flashStatus === "ok"    && <span className="text-xs text-green-400 font-mono">Flash réussi ✓</span>}
        {flashStatus === "error" && <span className="text-xs text-red-400 font-mono">Flash échoué</span>}
      </div>

      {/* ── Sensor selector ──────────────────────────────────────────────── */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <div className="flex items-center justify-between mb-3">
          <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">
            Capteurs physiquement connectés
          </label>
          {sensors.size > 0 && (
            <button
              onClick={() => { setSensors(new Set()); localStorage.removeItem(LS_SENSORS); }}
              className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
            >
              Réinitialiser
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {SENSORS.map((s) => {
            const active = sensors.has(s.id);
            return (
              <button
                key={s.id}
                onClick={() => toggleSensor(s.id)}
                title={s.hint}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-medium transition-all ${
                  active
                    ? "bg-blue-900/30 border-blue-600/60 text-blue-300"
                    : "bg-gray-800/50 border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-300"
                }`}
              >
                <span>{s.icon}</span>
                {s.label}
                {active && <span className="text-blue-400 ml-0.5">✓</span>}
              </button>
            );
          })}
        </div>
        {sensors.size === 0 && (
          <p className="text-[10px] text-gray-600 mt-2">
            Sélectionnez les capteurs câblés — les firmwares compatibles seront mis en avant.
          </p>
        )}
        {sensors.size > 0 && (
          <p className="text-[10px] text-gray-600 mt-2">
            Sélection mémorisée dans le navigateur.
          </p>
        )}
      </div>

      {/* Config grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

        {/* Example selector */}
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">
              Firmware à flasher
            </label>
            {historyHint && (
              <span className="text-[10px] text-gray-600 italic">
                Dernier : <span className="text-gray-400 font-mono">{historyHint}</span>
              </span>
            )}
          </div>
          <div className="space-y-1.5">
            {ranked.map((ex) => {
              const isSelected = example.id === ex.id;
              const compatColor =
                ex.compat === "recommended"  ? "text-green-400"
              : ex.compat === "incompatible" ? "text-gray-600"
              : "text-gray-500";
              const compatLabel =
                ex.compat === "recommended"  ? "● Recommandé"
              : ex.compat === "incompatible" ? "○ Capteur(s) manquant(s)"
              : null;
              return (
                <button
                  key={ex.id}
                  onClick={() => setExample(ex)}
                  className={`w-full text-left p-2.5 rounded border transition-all ${
                    isSelected
                      ? ex.compat === "recommended"
                        ? "border-green-700/50 bg-green-900/10"
                        : "border-blue-700/50 bg-blue-900/10"
                      : ex.compat === "incompatible"
                      ? "border-gray-800 opacity-50 hover:opacity-70"
                      : "border-gray-800 hover:border-gray-700 hover:bg-gray-800/40"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[11px] font-semibold ${ex.compat === "incompatible" ? "text-gray-500" : "text-gray-100"}`}>
                      {ex.label}
                    </span>
                    {compatLabel && sensors.size > 0 && (
                      <span className={`text-[9px] font-mono shrink-0 ${compatColor}`}>
                        {compatLabel}
                      </span>
                    )}
                  </div>
                  <div className="text-[9px] font-mono text-gray-500 mt-0.5">{ex.description}</div>
                  {ex.requiredSensors.length > 0 && (
                    <div className="flex gap-1 mt-1">
                      {ex.requiredSensors.map((s) => {
                        const meta = SENSORS.find((m) => m.id === s);
                        const ok   = sensors.has(s);
                        return (
                          <span
                            key={s}
                            className={`text-[9px] px-1.5 py-0.5 rounded-full border ${
                              ok
                                ? "border-green-700/40 text-green-400 bg-green-900/10"
                                : "border-gray-700 text-gray-600"
                            }`}
                          >
                            {meta?.icon} {meta?.label}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Port + launch */}
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 flex flex-col gap-3">

          {/* Port detection */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">Port série</label>
              {portBadge()}
            </div>

            {/* Disconnected warning overlay */}
            {portStatus === "disconnected" && (
              <div className="mb-2 rounded border border-amber-700/40 bg-amber-900/10 px-3 py-2 text-[10px] text-amber-400 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                Le port <code className="font-mono">{port}</code> a été débranché. Reconnectez le CH340 ou entrez un port manuellement.
              </div>
            )}

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
              <div className="w-full bg-gray-800/50 border border-dashed border-gray-700 rounded px-2.5 py-2 text-[11px] text-gray-600 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-gray-600 animate-pulse shrink-0" />
                Branchez le CH340 pour détecter automatiquement
              </div>
            )}

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
              >OK</button>
            </div>
            <p className="text-[9px] text-gray-600 mt-0.5">★ = ESP32 / CH340 probable</p>
          </div>

          {/* Hardware reminder */}
          <div className="rounded border border-amber-700/30 bg-amber-900/10 px-3 py-2 text-[10px] text-amber-400 leading-relaxed">
            <b>Rappel :</b> utiliser <code>board=esp32dev</code>.
            Ouvrir le moniteur série <em>après</em> le flash.
          </div>

          {/* Incompatibility warning */}
          {example && getCompat(example, sensors) === "incompatible" && sensors.size > 0 && (
            <div className="rounded border border-orange-700/40 bg-orange-900/10 px-3 py-2 text-[10px] text-orange-400 leading-relaxed">
              <b>Attention :</b> {example.label} nécessite{" "}
              {example.requiredSensors
                .filter((s) => !sensors.has(s))
                .map((s) => SENSORS.find((m) => m.id === s)?.label)
                .join(", ")}{" "}
              — non sélectionné. Le flash peut quand même réussir si le capteur est branché.
            </div>
          )}

          {/* Clean build toggle */}
          <label className="flex items-center gap-2.5 cursor-pointer select-none group">
            <div
              onClick={() => setCleanBuild((v) => !v)}
              className={`w-8 h-4 rounded-full transition-colors shrink-0 relative ${
                cleanBuild ? "bg-orange-600" : "bg-gray-700"
              }`}
            >
              <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                cleanBuild ? "translate-x-4" : "translate-x-0"
              }`} />
            </div>
            <span className="text-[10px] text-gray-400 group-hover:text-gray-200 transition-colors leading-tight">
              Compilation complète
              <span className="block text-[9px] text-gray-600">
                {cleanBuild
                  ? "Supprime .pio/build avant la compilation"
                  : "Réutilise le cache de compilation (+ rapide)"}
              </span>
            </span>
          </label>

          {/* Launch */}
          <button
            onClick={handleFlash}
            disabled={flashStatus === "running" || !effectivePort}
            className={`w-full py-2.5 rounded font-semibold text-sm tracking-wide transition-colors disabled:opacity-50 ${
              flashStatus === "running" ? "bg-blue-700 text-white cursor-wait"
              : flashStatus === "ok"    ? "bg-green-700 hover:bg-green-600 text-white"
              : cleanBuild             ? "bg-orange-600 hover:bg-orange-500 text-white"
              : "bg-blue-600 hover:bg-blue-500 text-white"
            }`}
          >
            {flashStatus === "running"
              ? "⟳ Flash en cours…"
              : effectivePort
              ? `${cleanBuild ? "🔄" : "⚡"} Flasher ${example.label} sur ${effectivePort}`
              : `${cleanBuild ? "🔄" : "⚡"} Compiler & Flasher`}
          </button>
        </div>
      </div>

      {/* Terminal */}
      {(log || flashStatus !== "idle") && (
        <div className="rounded-lg border border-gray-800 bg-gray-950 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
            <span className="text-[9px] font-mono uppercase tracking-widest text-gray-600">Sortie PlatformIO</span>
            <button
              onClick={() => { setLog(""); setFlashStatus("idle"); }}
              className="text-[9px] text-gray-700 hover:text-gray-400 transition-colors"
            >Effacer</button>
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
