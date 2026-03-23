"use client";

import React, { useState } from "react";

// ── Static mock data ──────────────────────────────────────────────────────────

const MODELS = [
  { id: "fat-v2.3.1", type: "FAT", name: "Fovet-Fatigue",   version: "v2.3.1",    meta: "847 KB · 12.4 ms · 94.3%", status: "PROD"    },
  { id: "pti-v1.8.4", type: "PTI", name: "Fovet-PTI",       version: "v1.8.4",    meta: "612 KB · 8.1 ms · 97.1%",  status: "PROD"    },
  { id: "str-v1.2.0", type: "STR", name: "Fovet-Stress",    version: "v1.2.0",    meta: "521 KB · 7.3 ms · 91.8%",  status: "PROD"    },
  { id: "fat-rc1",    type: "FAT", name: "Fovet-Fatigue",   version: "v2.4.0-rc1",meta: "Job #JB-0041",             status: "TRAIN"   },
  { id: "fat-v2.2.0", type: "FAT", name: "Fovet-Fatigue",   version: "v2.2.0",    meta: "archivé 12/03/2026",       status: "ARCH"    },
] as const;

type ModelStatus = "PROD" | "TRAIN" | "ARCH";

const DRIFT = [
  { id: "fat-v2.3.1", name: "Fovet-Fatigue v2.3.1", score: 0.78, level: "crit" as const, note: "▲ Seuil critique (0.70) — ré-entraînement en cours" },
  { id: "pti-v1.8.4", name: "Fovet-PTI v1.8.4",     score: 0.42, level: "med"  as const, note: "Surveillance recommandée" },
  { id: "str-v1.2.0", name: "Fovet-Stress v1.2.0",  score: 0.12, level: "ok"   as const, note: "Stable" },
];

const DEVICES = [
  { id: "SEN-001", model: "v2.3.1 · Alpha", note: "4.2 km · batt 82%", status: "on"      as const },
  { id: "SEN-002", model: "v2.3.1 · Alpha", note: "4.8 km · batt 71%", status: "on"      as const },
  { id: "SEN-003", model: "v2.3.1 · Alpha", note: "Mission active",     status: "warn"    as const },
  { id: "SEN-004", model: "v2.3.1 · Bravo", note: "7.1 km · batt 23%", status: "on"      as const },
  { id: "SEN-005", model: "v2.3.1 · Bravo", note: "Hors ligne 2h14",   status: "offline" as const },
];

const AUDIT = [
  { ts: "09:14", msg: <>a.porte a lancé job <b className="text-gray-100">#JB-0041</b> (Fatigue v2.4.0-rc1)</> },
  { ts: "09:08", msg: <>a.porte a validé dataset (1 248 sessions, 01/01→28/02)</> },
  { ts: "Hier",  msg: <>m.dupont a annulé le job <b className="text-gray-100">#JB-0040</b></> },
  { ts: "18/03", msg: <>a.porte a déployé <b className="text-gray-100">v2.3.1</b> sur SEN-001..005</> },
  { ts: "17/03", msg: <>m.dupont a promu <b className="text-gray-100">v2.3.1</b> en STAGING → PROD</> },
];

const LAST_DEPLOY = [
  { id: "SEN-001", ok: true }, { id: "SEN-002", ok: true },
  { id: "SEN-003", ok: true }, { id: "SEN-004", ok: true },
  { id: "SEN-005", ok: true },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function modelIcon(type: string) {
  if (type === "FAT") return "text-violet-400 bg-violet-900/20 border-violet-700/30";
  if (type === "PTI") return "text-blue-400 bg-blue-900/20 border-blue-700/30";
  return "text-amber-400 bg-amber-900/20 border-amber-700/30";
}

function statusBadge(s: ModelStatus) {
  if (s === "PROD")  return "bg-green-900/30 text-green-400 border-green-700/40";
  if (s === "TRAIN") return "bg-blue-900/30 text-blue-400 border-blue-700/40";
  if (s === "ARCH")  return "text-gray-600 border-gray-700";
  return "";
}

function driftColor(level: "ok" | "med" | "crit") {
  if (level === "crit") return { bar: "bg-red-500",   val: "text-red-400",   note: "text-red-400" };
  if (level === "med")  return { bar: "bg-amber-500", val: "text-amber-400", note: "text-amber-400" };
  return                       { bar: "bg-green-500", val: "text-green-400", note: "text-gray-500" };
}

function deviceDot(status: "on" | "warn" | "offline") {
  if (status === "on")      return "bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.5)] animate-pulse";
  if (status === "warn")    return "bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.5)] animate-pulse";
  return "bg-gray-700";
}

// ── Pipeline steps ────────────────────────────────────────────────────────────

const STEPS = [
  { num: "✓",  label: "Inventaire",    sub: "Modèles actifs",     state: "done"   as const },
  { num: "✓",  label: "Dataset",       sub: "Validé 23/03",       state: "done"   as const },
  { num: "◌",  label: "Entraînement",  sub: "67% — ~18 min",      state: "active" as const },
  { num: "4",  label: "Comparaison",   sub: "En attente",         state: "pending" as const },
  { num: "!",  label: "Validation",    sub: "Opérateur requis",   state: "alert"  as const },
  { num: "6",  label: "Déploiement",   sub: "OTA Sentinelle",     state: "pending" as const },
];

function stepNumCls(state: "done" | "active" | "pending" | "alert") {
  if (state === "done")    return "bg-green-900/30 border-green-700/50 text-green-400";
  if (state === "active")  return "bg-blue-900/30 border-blue-700/50 text-blue-400";
  if (state === "alert")   return "bg-amber-900/30 border-amber-700/50 text-amber-400";
  return "border-gray-700 text-gray-700";
}

function stepLabelCls(state: "done" | "active" | "pending" | "alert") {
  if (state === "done")    return "text-green-400";
  if (state === "active")  return "text-blue-400";
  if (state === "alert")   return "text-amber-400";
  return "text-gray-500";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ForgeTab() {
  const [selectedModel, setSelectedModel]   = useState<string>("fat-v2.3.1");
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(new Set(["SEN-001", "SEN-002"]));
  const [showTrainModal, setShowTrainModal] = useState(false);
  const [showDeployModal, setShowDeployModal] = useState(false);

  const toggleDevice = (id: string, offline: boolean) => {
    if (offline) return;
    setSelectedDevices(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col -mx-6 -mb-6 h-[calc(100vh-7rem)] overflow-hidden">

      {/* ── Forge header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-3 bg-gray-900 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[9px] uppercase tracking-[.22em] text-gray-500 px-2 py-0.5 border border-gray-700 rounded bg-gray-800">
            Module Forge
          </span>
          <div>
            <div className="text-[13px] font-semibold text-gray-100">
              Gestion des modèles IA — Pipeline d&apos;entraînement &amp; déploiement OTA
            </div>
            <div className="text-[10px] text-gray-500 mt-0.5">
              Sentinelle <span className="text-gray-700 mx-1">◈</span>
              12 dispositifs terrain <span className="text-gray-700 mx-1">◈</span>
              Modèle actif : Fovet-Fatigue v2.3.1
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-semibold uppercase tracking-wide border border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-200 hover:bg-gray-800 transition-colors">
            ↺ Actualiser
          </button>
          <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-semibold uppercase tracking-wide border border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-200 hover:bg-gray-800 transition-colors">
            ≡ Audit log
          </button>
          <button
            onClick={() => setShowTrainModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-semibold uppercase tracking-wide bg-blue-600 hover:bg-blue-700 text-white border border-blue-600 transition-colors"
          >
            + Nouveau cycle
          </button>
        </div>
      </div>

      {/* ── Pipeline stepper ─────────────────────────────────────────────── */}
      <div className="flex items-center px-5 h-11 bg-gray-900 border-b border-gray-800 flex-shrink-0 overflow-x-auto gap-0">
        {STEPS.map((step, i) => (
          <div key={i} className="flex items-center flex-1 min-w-[110px]">
            <div className="flex items-center gap-2">
              <div className={`w-[22px] h-[22px] flex-shrink-0 flex items-center justify-center rounded font-mono text-[10px] font-bold border ${stepNumCls(step.state)} ${step.state === "active" ? "animate-spin" : ""}`}
                style={step.state === "active" ? { animationDuration: "3s" } : {}}>
                {step.num}
              </div>
              <div>
                <div className={`text-[10px] font-semibold uppercase tracking-wide ${stepLabelCls(step.state)}`}>
                  {step.label}
                </div>
                <div className="font-mono text-[9px] text-gray-500">{step.sub}</div>
              </div>
            </div>
            {i < STEPS.length - 1 && (
              <div className="flex-1 h-px bg-gray-800 mx-2.5" />
            )}
          </div>
        ))}
      </div>

      {/* ── Three-column body ─────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* LEFT — Registry + Drift */}
        <div className="w-[300px] flex-shrink-0 border-r border-gray-800 overflow-y-auto p-3.5 flex flex-col gap-3">

          {/* Model registry */}
          <Panel title="Registre des modèles" action={
            <select className="bg-gray-900 border border-gray-700 rounded text-[9px] text-gray-400 px-2 py-1 cursor-pointer">
              <option>Tous</option><option>Fatigue</option><option>PTI</option><option>Stress</option>
            </select>
          }>
            <div className="font-mono text-[9px] uppercase tracking-[.14em] text-gray-700 mb-1.5 pb-1 border-b border-gray-800">
              Production
            </div>
            {MODELS.filter(m => m.status === "PROD").map(m => (
              <ModelRow key={m.id} model={m} selected={selectedModel === m.id} onClick={() => setSelectedModel(m.id)} />
            ))}
            <div className="h-px bg-gray-800 my-2" />
            <div className="font-mono text-[9px] uppercase tracking-[.14em] text-gray-700 mb-1.5 pb-1 border-b border-gray-800">
              Entraînement / Staging
            </div>
            {MODELS.filter(m => m.status === "TRAIN").map(m => (
              <ModelRow key={m.id} model={m} selected={selectedModel === m.id} onClick={() => setSelectedModel(m.id)} />
            ))}
            <div className="h-px bg-gray-800 my-2" />
            <div className="font-mono text-[9px] uppercase tracking-[.14em] text-gray-700 mb-1.5 pb-1 border-b border-gray-800">
              Archivés
            </div>
            {MODELS.filter(m => m.status === "ARCH").map(m => (
              <ModelRow key={m.id} model={m} selected={selectedModel === m.id} onClick={() => setSelectedModel(m.id)} dimmed />
            ))}
          </Panel>

          {/* Drift scores */}
          <Panel title="Score de dérive — Live" action={
            <span className="font-mono text-[9px] text-gray-700 tracking-wide">AUTO · 60s</span>
          }>
            {DRIFT.map(d => {
              const c = driftColor(d.level);
              return (
                <div key={d.id} className="mb-2.5 last:mb-0">
                  <div className="flex justify-between items-baseline mb-1">
                    <span className="text-[10px] text-gray-400">{d.name}</span>
                    <span className={`font-mono text-[11px] font-bold ${c.val}`}>{d.score.toFixed(2)}</span>
                  </div>
                  <div className="h-[3px] bg-gray-950 overflow-hidden">
                    <div className={`h-full ${c.bar}`} style={{ width: `${d.score * 100}%` }} />
                  </div>
                  <div className={`font-mono text-[9px] mt-0.5 ${c.note}`}>{d.note}</div>
                </div>
              );
            })}
          </Panel>

        </div>

        {/* CENTER — Job + Comparison + Validation */}
        <div className="flex-1 overflow-y-auto p-3.5 flex flex-col gap-3">

          {/* Active training job */}
          <Panel
            title={
              <span className="flex items-center gap-2">
                <span className="text-blue-400 animate-spin" style={{ animationDuration: "3s" }}>◌</span>
                Job d&apos;entraînement — <span className="font-mono text-blue-400">#JB-0041</span>
              </span>
            }
            action={
              <div className="flex items-center gap-2">
                <span className="font-mono text-[9px] text-gray-500">Fovet-Fatigue v2.4.0-rc1</span>
                <button className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded border border-transparent transition-colors">
                  Logs
                </button>
              </div>
            }
          >
            <div className="flex gap-2.5 items-start mb-3">
              <div className="flex-1">
                <div className="text-[12px] font-semibold text-gray-100 mb-0.5">
                  Epoch 34 / 50 — Validation en cours
                </div>
                <div className="font-mono text-[9px] text-gray-500 tracking-wide">
                  Démarré 23/03/2026 · 09:14 UTC
                  <span className="text-gray-700 mx-1">◈</span>
                  ETA ~18 min
                  <span className="text-gray-700 mx-1">◈</span>
                  1 248 sessions (01/01 → 28/02)
                </div>
              </div>
            </div>

            {/* Progress bar */}
            <div className="mb-3">
              <div className="flex justify-between mb-1">
                <span className="font-mono text-[9px] text-gray-500">Progression</span>
                <span className="font-mono text-[9px] font-bold text-blue-400">67%</span>
              </div>
              <div className="h-[3px] bg-gray-950">
                <div className="h-full bg-blue-500 transition-all" style={{ width: "67%" }} />
              </div>
            </div>

            {/* Stat grid */}
            <div className="grid grid-cols-3 gap-1.5 mb-3">
              {[
                { lbl: "Loss — train", val: "0.0812", delta: "▼ −0.012 /ep30", up: true },
                { lbl: "Loss — val",   val: "0.0934", delta: "▼ −0.008 /ep30", up: true },
                { lbl: "Acc — val",    val: "95.2%",  delta: "▲ +1.4% /ep30",  up: true, accent: "text-green-400" },
              ].map((s, i) => (
                <div key={i} className="bg-gray-800/50 border border-gray-700/60 rounded p-2">
                  <div className="font-mono text-[9px] uppercase tracking-wide text-gray-600 mb-1">{s.lbl}</div>
                  <div className={`font-mono text-[17px] font-bold leading-none ${s.accent ?? "text-blue-400"}`}>{s.val}</div>
                  <div className={`font-mono text-[9px] mt-0.5 ${s.up ? "text-green-400" : "text-red-400"}`}>{s.delta}</div>
                </div>
              ))}
            </div>

            {/* Logs */}
            <div className="font-mono text-[9px] uppercase tracking-[.14em] text-gray-700 mb-1.5 pb-1 border-b border-gray-800">
              Logs temps réel
            </div>
            <div className="bg-gray-950 border border-gray-800 rounded px-2.5 py-2 font-mono text-[10px] text-gray-500 max-h-28 overflow-y-auto leading-7">
              <span className="text-gray-700">[09:38]</span> <span className="text-blue-400">INFO</span>  Epoch 34/50 — val_loss=0.0934 val_acc=0.952<br/>
              <span className="text-gray-700">[09:37]</span> <span className="text-green-400">OK</span>    Checkpoint sauvegardé — fovet-fatigue-v2.4.0-ep34.pt<br/>
              <span className="text-gray-700">[09:36]</span> <span className="text-blue-400">INFO</span>  Epoch 33/50 — val_loss=0.0942 val_acc=0.951<br/>
              <span className="text-gray-700">[09:35]</span> <span className="text-amber-400">WARN</span>  LR scheduler réduit : 0.001 → 0.0005<br/>
              <span className="text-gray-700">[09:32]</span> <span className="text-green-400">OK</span>    Early stopping check ep30 — pas de dégradation<br/>
              <span className="text-gray-700">[09:14]</span> <span className="text-green-400">OK</span>    Job #JB-0041 démarré · dataset 1248 sessions · qualité signal 98.7%
            </div>
          </Panel>

          {/* Comparison table */}
          <Panel title="Comparaison modèles" action={
            <span className="font-mono text-[9px] text-gray-500">Projection epoch 50 (extrapolée)</span>
          }>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {["Métrique", "Actuel v2.3.1", "> Nouveau v2.4.0", "Delta"].map((h, i) => (
                    <th key={i} className={`text-left px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-wide border-b border-gray-800 ${i === 2 ? "text-blue-400" : "text-gray-600"}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  { label: "Accuracy",          old: "94.3%",  nw: "~95.8%", delta: "▲ +1.5%",   win: true  },
                  { label: "F1-Score",           old: "0.921",  nw: "~0.939", delta: "▲ +0.018",  win: true  },
                  { label: "Latence inférence",  old: "12.4 ms",nw: "~13.1 ms",delta:"▲ +0.7 ms", win: false },
                  { label: "Taille bundle",      old: "847 KB", nw: "~891 KB", delta: "▲ +44 KB",  win: false },
                  { label: "Faux positifs /h",   old: "2.1",    nw: "~1.4",   delta: "▼ −33%",   win: true  },
                  { label: "Drift score",        old: "0.78",   nw: "~0.11",  delta: "▼ −86%",   win: true, oldRed: true },
                ].map((row, i) => (
                  <tr key={i}>
                    <td className="px-2.5 py-2 text-[11px] text-gray-400 font-medium border-b border-gray-800">{row.label}</td>
                    <td className={`px-2.5 py-2 font-mono text-[11px] border-b border-gray-800 ${row.oldRed ? "text-red-400" : "text-gray-500"}`}>{row.old}</td>
                    <td className="px-2.5 py-2 font-mono text-[11px] text-blue-400 font-bold border-b border-gray-800">{row.nw}</td>
                    <td className={`px-2.5 py-2 font-mono text-[10px] border-b border-gray-800 ${row.win ? "text-green-400" : "text-red-400"}`}>{row.delta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="font-mono text-[9px] text-gray-700 mt-2">
              * Projection à partir des résultats epoch 34 — métriques définitives disponibles en fin de job
            </div>
          </Panel>

          {/* Validation call-out */}
          <div className="flex gap-3 items-start p-3 rounded border border-amber-700/40 bg-amber-900/10">
            <div className="text-amber-400 text-base flex-shrink-0 mt-0.5">!</div>
            <div className="flex-1">
              <div className="text-[11px] font-bold uppercase tracking-wide text-amber-400">
                Point de décision humaine requis — Validation du modèle
              </div>
              <div className="text-[10px] text-gray-400 mt-1 leading-relaxed">
                À la fin du job, comparez les métriques finales de v2.4.0 vs v2.3.1 (production), puis décidez de promouvoir
                le modèle en STAGING ou de le rejeter. Cette décision est journalisée dans l&apos;audit log avec horodatage
                et identifiant opérateur.
              </div>
              <div className="flex gap-2 mt-2.5">
                <button disabled className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wide bg-green-900/30 text-green-400 border border-green-700/40 opacity-40 cursor-not-allowed">
                  ✓ Valider &amp; promouvoir en staging
                </button>
                <button disabled className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wide bg-red-900/30 text-red-400 border border-red-700/40 opacity-40 cursor-not-allowed">
                  ✕ Rejeter &amp; archiver
                </button>
                <span className="font-mono text-[9px] text-gray-700 self-center ml-1">Disponible à la fin du job</span>
              </div>
            </div>
          </div>

        </div>

        {/* RIGHT — Devices + Last deploy + Audit */}
        <div className="w-[272px] flex-shrink-0 border-l border-gray-800 overflow-y-auto p-3.5 flex flex-col gap-3">

          {/* Sentinelle devices */}
          <Panel title="Dispositifs Sentinelle" action={
            <span className="font-mono text-[9px] text-green-400">12 / 14 en ligne</span>
          }>
            <div className="font-mono text-[9px] uppercase tracking-[.14em] text-gray-700 mb-1.5 pb-1 border-b border-gray-800">
              Sélectionner pour déploiement
            </div>
            {DEVICES.map(d => {
              const offline = d.status === "offline";
              const sel = selectedDevices.has(d.id) && !offline;
              return (
                <div
                  key={d.id}
                  onClick={() => toggleDevice(d.id, offline)}
                  className={`flex items-center gap-2 p-2 rounded mb-1.5 last:mb-0 border transition-all cursor-pointer
                    ${offline ? "opacity-40 cursor-not-allowed border-gray-800" : sel ? "border-blue-700/50 bg-blue-900/10" : "border-gray-800 hover:border-gray-700 hover:bg-gray-800/50"}`}
                >
                  <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${deviceDot(d.status)}`} />
                  <div className="font-mono text-[10px] font-bold w-14 flex-shrink-0 text-gray-400">{d.id}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] text-gray-400">{d.model}</div>
                    <div className={`font-mono text-[9px] ${d.status === "warn" ? "text-amber-400" : "text-gray-500"}`}>{d.note}</div>
                  </div>
                  <div className={`w-3.5 h-3.5 rounded flex-shrink-0 flex items-center justify-center border text-[8px] transition-all
                    ${sel ? "bg-blue-600 border-blue-600 text-white" : "border-gray-700 bg-gray-900"}`}>
                    {sel && "✓"}
                  </div>
                </div>
              );
            })}
            <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-gray-800">
              <span className="font-mono text-[9px] text-gray-500">{selectedDevices.size} sélectionné{selectedDevices.size > 1 ? "s" : ""}</span>
              <button
                disabled
                onClick={() => setShowDeployModal(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wide bg-blue-600 text-white border border-blue-600 opacity-40 cursor-not-allowed"
              >
                ↑ Déployer (après validation)
              </button>
            </div>
          </Panel>

          {/* Last deployment */}
          <Panel title="Dernier déploiement OTA" action={
            <span className="font-mono text-[9px] text-gray-500">#DEP-0038</span>
          }>
            <div className="font-mono text-[9px] text-gray-700 mb-2">18/03/2026 09:05 UTC · v2.3.1 · 5 dispositifs</div>
            {LAST_DEPLOY.map(d => (
              <div key={d.id} className="flex items-center gap-2 py-1.5 border-b border-gray-800 last:border-b-0">
                <span className="font-mono text-[10px] text-gray-500 w-14 flex-shrink-0">{d.id}</span>
                <div className="flex-1 h-[3px] bg-gray-950">
                  <div className="h-full bg-green-500" style={{ width: "100%" }} />
                </div>
                <span className="font-mono text-[9px] uppercase w-14 text-right flex-shrink-0 text-green-400">OK</span>
              </div>
            ))}
          </Panel>

          {/* Audit log */}
          <Panel title="Audit log" action={
            <button className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded border border-transparent transition-colors">
              Tout voir
            </button>
          }>
            {AUDIT.map((entry, i) => (
              <div key={i} className="flex gap-2.5 py-1.5 border-b border-gray-800 last:border-b-0">
                <span className="font-mono text-[9px] text-gray-700 flex-shrink-0 w-9 pt-0.5">{entry.ts}</span>
                <span className="text-[10px] text-gray-400 leading-snug">{entry.msg}</span>
              </div>
            ))}
          </Panel>

        </div>
      </div>

      {/* ── Modal — Nouveau cycle ──────────────────────────────────────────── */}
      {showTrainModal && (
        <Modal title="+ Nouveau cycle d'entraînement" onClose={() => setShowTrainModal(false)}>
          <p className="text-[11px] text-gray-400 mb-3 leading-relaxed">
            Configurez les paramètres du cycle. Les données terrain seront extraites depuis les dispositifs
            Sentinelle pour la plage sélectionnée.
          </p>
          <div className="mb-2.5">
            <label className="font-mono text-[9px] uppercase tracking-wide text-gray-500 block mb-1">Modèle de base</label>
            <select className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500">
              <option>Fovet-Fatigue v2.3.1 (PROD)</option>
              <option>Fovet-PTI v1.8.4 (PROD)</option>
              <option>Fovet-Stress v1.2.0 (PROD)</option>
            </select>
          </div>
          <div className="mb-2.5">
            <label className="font-mono text-[9px] uppercase tracking-wide text-gray-500 block mb-1">Plage de données terrain</label>
            <div className="grid grid-cols-2 gap-2">
              <input type="date" defaultValue="2026-01-01" className="bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500" />
              <input type="date" defaultValue="2026-02-28" className="bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500" />
            </div>
          </div>
          <div className="mb-3">
            <label className="font-mono text-[9px] uppercase tracking-wide text-gray-500 block mb-1">Profil d&apos;entraînement</label>
            <select className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500">
              <option>Standard — 50 epochs, batch 32</option>
              <option>Rapide — 25 epochs, batch 64</option>
              <option>Précis — 100 epochs, batch 16</option>
              <option>Personnalisé</option>
            </select>
          </div>
          <div className="bg-amber-900/10 border border-amber-700/40 rounded px-3 py-2 text-[10px] text-amber-400 mb-3 leading-relaxed">
            Point de décision humaine : vous devrez valider manuellement le modèle résultant avant tout déploiement
            sur les dispositifs Sentinelle. Cette action sera journalisée.
          </div>
          <div className="flex gap-2 justify-end pt-3 border-t border-gray-800">
            <button onClick={() => setShowTrainModal(false)} className="px-3 py-1.5 rounded text-[11px] font-semibold uppercase tracking-wide border border-gray-700 text-gray-400 hover:border-gray-600 hover:bg-gray-800 transition-colors">
              Annuler
            </button>
            <button onClick={() => setShowTrainModal(false)} className="px-3 py-1.5 rounded text-[11px] font-semibold uppercase tracking-wide bg-blue-600 hover:bg-blue-700 text-white border border-blue-600 transition-colors">
              Lancer l&apos;entraînement
            </button>
          </div>
        </Modal>
      )}

      {/* ── Modal — Déploiement OTA ────────────────────────────────────────── */}
      {showDeployModal && (
        <Modal title="↑ Confirmer le déploiement OTA" onClose={() => setShowDeployModal(false)}>
          <p className="text-[11px] text-gray-400 mb-3 leading-relaxed">
            Déploiement de <b className="text-gray-100">Fovet-Fatigue v2.4.0</b> sur{" "}
            <b className="text-gray-100">{selectedDevices.size} dispositifs Sentinelle</b> sélectionnés.
          </p>
          <div className="bg-amber-900/10 border border-amber-700/40 rounded px-3 py-2 text-[10px] text-amber-400 mb-3 leading-relaxed">
            Action irréversible. En cas d&apos;échec, rollback automatique vers v2.3.1.
          </div>
          <div className="bg-gray-800/50 border border-gray-700/60 rounded px-3 py-2 mb-3">
            {Array.from(selectedDevices).map(id => (
              <div key={id} className="flex justify-between items-baseline py-1 border-b border-gray-800 last:border-b-0">
                <span className="text-[10px] text-gray-500">{id}</span>
                <span className="font-mono text-[10px] text-green-400">Opérationnel</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2 justify-end pt-3 border-t border-gray-800">
            <button onClick={() => setShowDeployModal(false)} className="px-3 py-1.5 rounded text-[11px] font-semibold uppercase tracking-wide border border-gray-700 text-gray-400 hover:border-gray-600 hover:bg-gray-800 transition-colors">
              Annuler
            </button>
            <button onClick={() => setShowDeployModal(false)} className="px-3 py-1.5 rounded text-[11px] font-semibold uppercase tracking-wide bg-red-900/30 text-red-400 border border-red-700/40 hover:bg-red-900/50 transition-colors">
              Confirmer le déploiement
            </button>
          </div>
        </Modal>
      )}

    </div>
  );
}

// ── Reusable sub-components ───────────────────────────────────────────────────

function Panel({ title, action, children }: {
  title: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-gray-400">
          <span className="text-gray-600">◈</span>
          {title}
        </div>
        {action && <div>{action}</div>}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function ModelRow({ model, selected, onClick, dimmed }: {
  model: typeof MODELS[number];
  selected: boolean;
  onClick: () => void;
  dimmed?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-2 p-2 rounded mb-1 last:mb-0 cursor-pointer border transition-all
        ${selected ? "border-blue-700/50 bg-blue-900/10" : "border-transparent hover:bg-gray-800 hover:border-gray-700"}
        ${dimmed ? "opacity-45" : ""}`}
    >
      <div className={`w-7 h-7 rounded flex-shrink-0 border flex items-center justify-center font-mono text-[9px] font-bold uppercase tracking-wide ${modelIcon(model.type)}`}>
        {model.type}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold text-gray-100 truncate">{model.name}</div>
        <div className="font-mono text-[9px] text-gray-500 mt-0.5">{model.version} · {model.meta}</div>
      </div>
      <span className={`font-mono text-[8px] uppercase tracking-wide px-1.5 py-0.5 rounded border flex-shrink-0 ${statusBadge(model.status as ModelStatus)}`}>
        {model.status}
      </span>
    </div>
  );
}

function Modal({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/75 flex items-center justify-center z-50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-gray-900 border border-gray-700 rounded w-[420px] max-w-[92vw] p-5 shadow-2xl">
        <div className="flex items-start justify-between mb-3.5">
          <div className="text-[13px] font-bold text-gray-100">{title}</div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 text-base leading-none ml-3 transition-colors">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
