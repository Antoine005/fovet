/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */
"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch } from "@/lib/api-client";

// ── API types ─────────────────────────────────────────────────────────────────

interface ApiModel {
  id: string;
  name: string;
  type: string;
  version: string;
  status: "PROD" | "TRAIN" | "ARCH";
  sizeKb: number | null;
  latencyMs: number | null;
  accuracy: number | null;
  driftScore: number | null;
  driftLevel: string | null;
  driftNote: string | null;
}

interface ApiJob {
  id: string;
  jobRef: string;
  modelId: string | null;
  status: "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
  progress: number;
  currentEpoch: number;
  totalEpochs: number;
  eta: string | null;
  datasetSessions: number | null;
  logs: string | null;
  trainLoss: number | null;
  valLoss: number | null;
  valAccuracy: number | null;
  startedAt: string;
  finishedAt: string | null;
  model: { name: string; version: string; type: string } | null;
}

interface ApiDevice {
  id: string;
  name: string;
  mqttClientId: string;
  location: string | null;
  active: boolean;
  latestModelId: string | null;
  lastReadingAt: string | null;
}

interface ApiDrift {
  id: string;
  name: string;
  score: number;
  level: "ok" | "med" | "crit";
  note: string;
}

interface ApiDeploy {
  id: string;
  deployRef: string;
  modelId: string;
  deviceIds: string[];
  status: string;
  results: Record<string, string> | null;
  deployedAt: string;
}

interface ApiAuditEntry {
  id: string;
  actor: string;
  action: string;
  label: string | null;
  modelRef: string | null;
  jobRef: string | null;
  deployRef: string | null;
  createdAt: string;
}

interface AlgorithmMeta {
  id: string;
  name: string;
  description: string;
  export_format: string;
  ram_bytes_estimate: string;
  params: { key: string; type: string; default: number; min: number; max: number }[];
  suitable_for: string[];
  requires?: string;
}

const ALGO_TO_YAML: Record<string, string> = {
  zscore:            "demo_zscore.yaml",
  isolation_forest:  "demo_zscore.yaml",
  ewma_drift:        "demo_drift.yaml",
  mad:               "demo_mad.yaml",
  autoencoder:       "demo_autoencoder.yaml",
  lstm_autoencoder:  "demo_lstm_autoencoder.yaml",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function modelIcon(type: string) {
  if (type === "FAT") return "text-violet-400 bg-violet-900/20 border-violet-700/30";
  if (type === "PTI") return "text-blue-400 bg-blue-900/20 border-blue-700/30";
  return "text-amber-400 bg-amber-900/20 border-amber-700/30";
}

function statusBadge(s: "PROD" | "TRAIN" | "ARCH") {
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

function deviceDot(online: boolean, warn: boolean) {
  if (!online)  return "bg-gray-700";
  if (warn)     return "bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.5)] animate-pulse";
  return "bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.5)] animate-pulse";
}

function formatAuditTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === 0) return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 1) return "Hier";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

// ── Pipeline steps derived from active job ────────────────────────────────────

type StepState = "done" | "active" | "pending" | "alert";
interface StepDef { num: string; label: string; sub: string; state: StepState }

function buildSteps(activeJob: ApiJob | null, hasModels: boolean): StepDef[] {
  const running  = activeJob?.status === "RUNNING";
  const done     = activeJob?.status === "DONE";
  const progress = activeJob?.progress ?? 0;
  const eta      = activeJob?.eta ?? "…";
  const epoch    = activeJob ? `${activeJob.currentEpoch} / ${activeJob.totalEpochs}` : "—";
  const startDate = activeJob ? new Date(activeJob.startedAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

  return [
    { num: hasModels ? "✓" : "1", label: "Inventaire",   sub: hasModels ? "Modèles actifs" : "Aucun modèle",     state: hasModels ? "done"    : "pending" },
    { num: activeJob ? "✓" : "2", label: "Dataset",      sub: activeJob ? `Validé ${startDate}` : "En attente", state: activeJob ? "done"    : "pending" },
    { num: running ? "◌" : (done ? "✓" : "3"), label: "Entraînement", sub: running ? `${progress}% — ~${eta}` : (done ? `Epoch ${epoch}` : "En attente"), state: running ? "active" : (done ? "done" : "pending") },
    { num: done ? "✓" : "4",      label: "Comparaison",  sub: done ? "Disponible" : "En attente",               state: done ? "done"    : "pending" },
    { num: done ? "!" : "5",      label: "Validation",   sub: done ? "Opérateur requis" : "En attente",         state: done ? "alert"   : "pending" },
    { num: "6",                   label: "Déploiement",  sub: "OTA Pulse",                                  state: "pending" },
  ];
}

function stepNumCls(state: StepState) {
  if (state === "done")    return "bg-green-900/30 border-green-700/50 text-green-400";
  if (state === "active")  return "bg-blue-900/30 border-blue-700/50 text-blue-400";
  if (state === "alert")   return "bg-amber-900/30 border-amber-700/50 text-amber-400";
  return "border-gray-700 text-gray-700";
}

function stepLabelCls(state: StepState) {
  if (state === "done")    return "text-green-400";
  if (state === "active")  return "text-blue-400";
  if (state === "alert")   return "text-amber-400";
  return "text-gray-500";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ForgeTab() {
  const [selectedModel,   setSelectedModel]   = useState<string | null>(null);
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(new Set());
  const [showTrainModal,  setShowTrainModal]  = useState(false);
  const [showDeployModal, setShowDeployModal] = useState(false);

  // Data state
  const [models,      setModels]      = useState<ApiModel[]>([]);
  const [driftScores, setDriftScores] = useState<ApiDrift[]>([]);
  const [activeJob,   setActiveJob]   = useState<ApiJob | null>(null);
  const [recentJobs,  setRecentJobs]  = useState<ApiJob[]>([]);
  const [devices,     setDevices]     = useState<ApiDevice[]>([]);
  const [latestDeploy,setLatestDeploy]= useState<ApiDeploy | null>(null);
  const [auditLog,    setAuditLog]    = useState<ApiAuditEntry[]>([]);

  // Loading/error state
  const [loadingModels,  setLoadingModels]  = useState(true);
  const [loadingJobs,    setLoadingJobs]    = useState(true);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [loadingAudit,   setLoadingAudit]   = useState(true);
  const [errorModels,    setErrorModels]    = useState<string | null>(null);

  // Train modal form state
  const [trainBaseModel, setTrainBaseModel] = useState("");
  const [trainProfile,   setTrainProfile]   = useState("standard");
  const [submittingJob,  setSubmittingJob]  = useState(false);

  // Data source tabs
  type DataTab = "csv" | "capture" | "synthetic";
  const [dataTab,        setDataTab]        = useState<DataTab>("synthetic");

  // CSV upload
  const [uploadFile,     setUploadFile]     = useState<File | null>(null);
  const [uploadResult,   setUploadResult]   = useState<{ dataPath: string; columns: string[]; rows: number; preview: string[] } | null>(null);
  const [uploadError,    setUploadError]    = useState<string | null>(null);
  const [uploading,      setUploading]      = useState(false);

  // DB capture
  const [captureDevice,  setCaptureDevice]  = useState("");
  const [captureFrom,    setCaptureFrom]    = useState(() => new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const [captureTo,      setCaptureTo]      = useState(() => new Date().toISOString().slice(0, 10));
  const [captureResult,  setCaptureResult]  = useState<{ dataPath: string; rows: number } | null>(null);
  const [captureError,   setCaptureError]   = useState<string | null>(null);
  const [capturing,      setCapturing]      = useState(false);

  // Synthetic params
  const [synthSignal,    setSynthSignal]    = useState<"sine" | "random_walk" | "constant">("sine");
  const [synthSamples,   setSynthSamples]   = useState(1000);
  const [synthNoise,     setSynthNoise]     = useState(0.1);
  const [synthAnomalyRate, setSynthAnomalyRate] = useState(0.05);
  const [synthAnomalyMag,  setSynthAnomalyMag]  = useState(5.0);
  const [submittingDeploy, setSubmittingDeploy] = useState(false);
  const [validating,     setValidating]     = useState(false);
  const [showLogs,       setShowLogs]       = useState(false);
  const [logsContent,    setLogsContent]    = useState<string | null>(null);

  // Algorithms (from API)
  const [algorithms,      setAlgorithms]      = useState<AlgorithmMeta[]>([]);
  const [selectedAlgo,    setSelectedAlgo]    = useState("zscore");

  // Live SSE logs for active Forge job
  const [liveLog,         setLiveLog]         = useState("");
  const liveLogEs         = useRef<EventSource | null>(null);
  const liveLogRef        = useRef<HTMLDivElement>(null);

  // Flash-deploy from Forge job
  const [showFlashDeployModal, setShowFlashDeployModal] = useState(false);
  const [flashDeployJobId,     setFlashDeployJobId]     = useState<string | null>(null);
  const [flashDeployLog,       setFlashDeployLog]       = useState("");
  const [flashDeployStatus,    setFlashDeployStatus]    = useState<"idle" | "running" | "ok" | "error">("idle");
  const [flashDeployPort,      setFlashDeployPort]      = useState("COM4");
  const [flashDeployDeviceId,  setFlashDeployDeviceId]  = useState("");
  const flashDeployEs     = useRef<EventSource | null>(null);
  const flashLogRef       = useRef<HTMLDivElement>(null);

  const fetchAll = useCallback(async () => {
    // Models + drift
    setLoadingModels(true);
    setErrorModels(null);
    try {
      const [modRes, driftRes] = await Promise.all([
        apiFetch("/api/forge/models"),
        apiFetch("/api/forge/drift"),
      ]);
      if (modRes.ok) {
        const data: ApiModel[] = await modRes.json();
        setModels(data);
        if (!selectedModel && data.length > 0) {
          const prod = data.find((m) => m.status === "PROD");
          setSelectedModel(prod?.id ?? data[0].id);
        }
      } else {
        setErrorModels("Impossible de charger les modèles");
      }
      if (driftRes.ok) setDriftScores(await driftRes.json());
    } catch {
      setErrorModels("Erreur réseau");
    } finally {
      setLoadingModels(false);
    }

    // Jobs
    setLoadingJobs(true);
    try {
      const [activeRes, recentRes] = await Promise.all([
        apiFetch("/api/forge/jobs?status=RUNNING"),
        apiFetch("/api/forge/jobs"),
      ]);
      if (activeRes.ok) {
        const running: ApiJob[] = await activeRes.json();
        setActiveJob(running[0] ?? null);
      }
      if (recentRes.ok) setRecentJobs(await recentRes.json());
    } finally {
      setLoadingJobs(false);
    }

    // Devices
    setLoadingDevices(true);
    try {
      const devRes = await apiFetch("/api/devices");
      if (devRes.ok) setDevices(await devRes.json());
    } finally {
      setLoadingDevices(false);
    }

    // Latest deploys + audit
    setLoadingAudit(true);
    try {
      const [auditRes, deploysRes] = await Promise.all([
        apiFetch("/api/forge/audit"),
        apiFetch("/api/forge/deploys?limit=1"),
      ]);
      if (auditRes.ok)   setAuditLog(await auditRes.json());
      if (deploysRes.ok) {
        const deploys: ApiDeploy[] = await deploysRes.json();
        setLatestDeploy(deploys[0] ?? null);
      }
    } finally {
      setLoadingAudit(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchAll();
    // Load algorithms from API (dynamic from forge CLI)
    apiFetch("/api/forge/algorithms").then(async (r) => {
      if (r.ok) {
        const data: AlgorithmMeta[] = await r.json();
        setAlgorithms(data);
      }
    });
  }, [fetchAll]);

  // Auto-refresh: 2s while a job is running, 30s otherwise
  useEffect(() => {
    const interval = activeJob ? 2_000 : 30_000;
    const id = setInterval(fetchAll, interval);
    return () => clearInterval(id);
  }, [activeJob, fetchAll]);

  // SSE: stream live logs when a Forge job is RUNNING
  useEffect(() => {
    if (!activeJob || activeJob.status !== "RUNNING") {
      liveLogEs.current?.close();
      liveLogEs.current = null;
      return;
    }
    // Close previous
    liveLogEs.current?.close();
    setLiveLog("");

    const es = new EventSource(`/api/forge/jobs/${activeJob.id}/stream`);
    liveLogEs.current = es;

    es.addEventListener("log", (e) => {
      try {
        const chunk: string = JSON.parse((e as MessageEvent).data);
        setLiveLog((prev) => {
          const next = prev + chunk;
          // Auto-scroll
          setTimeout(() => {
            if (liveLogRef.current) liveLogRef.current.scrollTop = liveLogRef.current.scrollHeight;
          }, 0);
          return next;
        });
      } catch { /* ignore */ }
    });

    es.addEventListener("done", () => {
      es.close();
      liveLogEs.current = null;
      fetchAll(); // refresh job status
    });

    es.onerror = () => { es.close(); liveLogEs.current = null; };

    return () => { es.close(); liveLogEs.current = null; };
  }, [activeJob?.id, activeJob?.status, fetchAll]);

  useEffect(() => {
    if (flashLogRef.current) flashLogRef.current.scrollTop = flashLogRef.current.scrollHeight;
  }, [flashDeployLog]);

  const toggleDevice = (id: string, offline: boolean) => {
    if (offline) return;
    setSelectedDevices(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Validate that a data source is ready before launching
  const dataSourceReady = (): boolean => {
    if (dataTab === "csv")     return uploadResult !== null;
    if (dataTab === "capture") return captureResult !== null;
    return true; // synthetic always ready
  };

  const handleUploadCsv = async () => {
    if (!uploadFile) return;
    setUploading(true); setUploadError(null); setUploadResult(null);
    try {
      const form = new FormData();
      form.append("file", uploadFile);
      const res = await fetch("/api/forge/data/upload", { method: "POST", body: form, credentials: "include" });
      const json = await res.json() as { dataPath?: string; columns?: string[]; rows?: number; preview?: string[]; error?: string };
      if (!res.ok) { setUploadError(json.error ?? "Erreur upload"); return; }
      setUploadResult({ dataPath: json.dataPath!, columns: json.columns!, rows: json.rows!, preview: json.preview! });
    } catch (e) { setUploadError(String(e)); }
    finally { setUploading(false); }
  };

  const handleCapture = async () => {
    setCapturing(true); setCaptureError(null); setCaptureResult(null);
    try {
      const res = await apiFetch("/api/forge/data/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: captureDevice || undefined, from: captureFrom, to: captureTo, limit: 5000 }),
      });
      const json = await res.json() as { dataPath?: string; rows?: number; error?: string };
      if (!res.ok) { setCaptureError(json.error ?? "Erreur capture"); return; }
      setCaptureResult({ dataPath: json.dataPath!, rows: json.rows! });
    } catch (e) { setCaptureError(String(e)); }
    finally { setCapturing(false); }
  };

  const handleLaunchJob = async () => {
    if (!dataSourceReady()) return;
    setSubmittingJob(true);
    try {
      const epochs = trainProfile === "rapide" ? 25 : trainProfile === "precis" ? 100 : 50;

      // Build dataSource or fall back to static YAML
      let body: Record<string, unknown>;
      if (dataTab === "synthetic") {
        body = {
          baseModelId: trainBaseModel || undefined,
          totalEpochs: epochs,
          algo:        selectedAlgo,
          dataSource: {
            type:        "synthetic",
            signal:      synthSignal,
            nSamples:    synthSamples,
            noiseStd:    synthNoise,
            anomalyRate: synthAnomalyRate,
            anomalyMag:  synthAnomalyMag,
          },
        };
      } else {
        const dataPath   = dataTab === "csv" ? uploadResult!.dataPath : captureResult!.dataPath;
        const columns    = dataTab === "csv" ? uploadResult!.columns  : ["value"];
        body = {
          baseModelId: trainBaseModel || undefined,
          totalEpochs: epochs,
          algo:        selectedAlgo,
          dataSource: { type: dataTab === "csv" ? "csv" : "db", dataPath, columns },
        };
      }

      const res = await apiFetch("/api/forge/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setShowTrainModal(false);
        setUploadResult(null); setCaptureResult(null);
        await fetchAll();
      }
    } finally {
      setSubmittingJob(false);
    }
  };

  const handleValidate = async (decision: "PROMOTE" | "REJECT") => {
    const job = recentJobs.find((j) => j.status === "DONE");
    if (!job) return;
    setValidating(true);
    try {
      const res = await apiFetch(`/api/forge/jobs/${job.id}/validate`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, actor: "operator" }),
      });
      if (res.ok) await fetchAll();
    } finally {
      setValidating(false);
    }
  };

  const handleFlashDeploy = async () => {
    if (!flashDeployDeviceId) return;
    const doneJob = recentJobs.find((j) => j.status === "DONE");
    if (!doneJob) return;

    setFlashDeployStatus("running");
    setFlashDeployLog("");
    flashDeployEs.current?.close();

    const res = await apiFetch(`/api/forge/jobs/${doneJob.id}/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: flashDeployDeviceId,
        project:  "zscore_demo",
        port:     flashDeployPort,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setFlashDeployLog(`Erreur : ${(err as { error?: string }).error ?? res.status}`);
      setFlashDeployStatus("error");
      return;
    }

    const { flashJobId } = await res.json() as { flashJobId: string };
    const es = new EventSource(`/api/flash/stream/${flashJobId}`);
    flashDeployEs.current = es;

    es.addEventListener("log", (e) => {
      try {
        const text: string = JSON.parse((e as MessageEvent).data);
        setFlashDeployLog((prev) => prev + text);
      } catch { setFlashDeployLog((prev) => prev + (e as MessageEvent).data); }
    });

    es.addEventListener("done", (e) => {
      const code = parseInt((e as MessageEvent).data, 10);
      setFlashDeployStatus(code === 0 ? "ok" : "error");
      es.close();
    });

    es.onerror = () => { setFlashDeployStatus("error"); es.close(); };
  };

  const handleShowLogs = async () => {
    if (showLogs) { setShowLogs(false); return; }
    const job = activeJob ?? recentJobs[0];
    if (!job) return;
    const res = await apiFetch(`/api/forge/jobs/${job.id}/logs`);
    if (res.ok) {
      const data = await res.json();
      setLogsContent(data.logs ?? "(aucun log)");
    }
    setShowLogs(true);
  };

  const handleDeploy = async () => {
    if (!selectedModel || selectedDevices.size === 0) return;
    setSubmittingDeploy(true);
    try {
      const res = await apiFetch("/api/forge/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId:   selectedModel,
          deviceIds: Array.from(selectedDevices),
        }),
      });
      if (res.ok) {
        setShowDeployModal(false);
        await fetchAll();
      }
    } finally {
      setSubmittingDeploy(false);
    }
  };

  const steps = buildSteps(activeJob, models.length > 0);
  const prodModels   = models.filter((m) => m.status === "PROD");
  const trainModels  = models.filter((m) => m.status === "TRAIN");
  const archModels   = models.filter((m) => m.status === "ARCH");
  const onlineCount  = devices.filter((d) => d.active).length;
  const selectedModelObj = models.find((m) => m.id === selectedModel) ?? null;

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
              Pulse <span className="text-gray-700 mx-1">◈</span>
              {devices.length} dispositifs terrain <span className="text-gray-700 mx-1">◈</span>
              {selectedModelObj
                ? `Modèle actif : ${selectedModelObj.name} ${selectedModelObj.version}`
                : "Aucun modèle sélectionné"}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchAll}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-semibold uppercase tracking-wide border border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-200 hover:bg-gray-800 transition-colors"
          >
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
        {steps.map((step, i) => (
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
            {i < steps.length - 1 && (
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
            {loadingModels ? (
              <EmptyState msg="Chargement…" />
            ) : errorModels ? (
              <EmptyState msg={errorModels} error />
            ) : models.length === 0 ? (
              <EmptyState msg="Aucun modèle enregistré — lancez votre premier job" />
            ) : (
              <>
                <div className="font-mono text-[9px] uppercase tracking-[.14em] text-gray-700 mb-1.5 pb-1 border-b border-gray-800">
                  Production
                </div>
                {prodModels.length === 0
                  ? <EmptyState msg="Aucun modèle en production" />
                  : prodModels.map(m => (
                    <ModelRow key={m.id} model={m} selected={selectedModel === m.id} onClick={() => setSelectedModel(m.id)} />
                  ))
                }
                <div className="h-px bg-gray-800 my-2" />
                <div className="font-mono text-[9px] uppercase tracking-[.14em] text-gray-700 mb-1.5 pb-1 border-b border-gray-800">
                  Entraînement / Staging
                </div>
                {trainModels.length === 0
                  ? <EmptyState msg="Aucun job en cours" />
                  : trainModels.map(m => (
                    <ModelRow key={m.id} model={m} selected={selectedModel === m.id} onClick={() => setSelectedModel(m.id)} />
                  ))
                }
                <div className="h-px bg-gray-800 my-2" />
                <div className="font-mono text-[9px] uppercase tracking-[.14em] text-gray-700 mb-1.5 pb-1 border-b border-gray-800">
                  Archivés
                </div>
                {archModels.length === 0
                  ? <EmptyState msg="Aucun modèle archivé" />
                  : archModels.map(m => (
                    <ModelRow key={m.id} model={m} selected={selectedModel === m.id} onClick={() => setSelectedModel(m.id)} dimmed />
                  ))
                }
              </>
            )}
          </Panel>

          {/* Drift scores */}
          <Panel title="Score de dérive — Live" action={
            <span className="font-mono text-[9px] text-gray-700 tracking-wide">AUTO · 30s</span>
          }>
            {driftScores.length === 0 ? (
              <EmptyState msg="Aucun score de dérive — déployez un modèle en PROD" />
            ) : (
              driftScores.map(d => {
                const col = driftColor(d.level);
                return (
                  <div key={d.id} className="mb-2.5 last:mb-0">
                    <div className="flex justify-between items-baseline mb-1">
                      <span className="text-[10px] text-gray-400">{d.name}</span>
                      <span className={`font-mono text-[11px] font-bold ${col.val}`}>{d.score.toFixed(2)}</span>
                    </div>
                    <div className="h-[3px] bg-gray-950 overflow-hidden">
                      <div className={`h-full ${col.bar}`} style={{ width: `${d.score * 100}%` }} />
                    </div>
                    <div className={`font-mono text-[9px] mt-0.5 ${col.note}`}>{d.note}</div>
                  </div>
                );
              })
            )}
          </Panel>

        </div>

        {/* CENTER — Job + Comparison + Validation */}
        <div className="flex-1 overflow-y-auto p-3.5 flex flex-col gap-3">

          {/* Active training job */}
          {loadingJobs ? (
            <Panel title="Job d'entraînement"><EmptyState msg="Chargement…" /></Panel>
          ) : activeJob ? (
            <Panel
              title={
                <span className="flex items-center gap-2">
                  <span className="text-blue-400 animate-spin" style={{ animationDuration: "3s" }}>◌</span>
                  Job d&apos;entraînement — <span className="font-mono text-blue-400">{activeJob.jobRef}</span>
                </span>
              }
              action={
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[9px] text-gray-500">
                    {activeJob.model ? `${activeJob.model.name} (base)` : "Nouveau modèle"}
                  </span>
                  <button
                    onClick={handleShowLogs}
                    className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-wide hover:bg-gray-800 rounded border transition-colors ${showLogs ? "text-blue-400 border-blue-700/40" : "text-gray-500 border-transparent hover:text-gray-300"}`}
                  >
                    Logs
                  </button>
                </div>
              }
            >
              <div className="flex gap-2.5 items-start mb-3">
                <div className="flex-1">
                  <div className="text-[12px] font-semibold text-gray-100 mb-0.5">
                    Epoch {activeJob.currentEpoch} / {activeJob.totalEpochs} — Validation en cours
                  </div>
                  <div className="font-mono text-[9px] text-gray-500 tracking-wide">
                    Démarré {new Date(activeJob.startedAt).toLocaleString("fr-FR")}
                    {activeJob.eta && <><span className="text-gray-700 mx-1">◈</span>ETA ~{activeJob.eta}</>}
                    {activeJob.datasetSessions && <><span className="text-gray-700 mx-1">◈</span>{activeJob.datasetSessions} sessions</>}
                  </div>
                </div>
              </div>

              {/* Progress bar */}
              <div className="mb-3">
                <div className="flex justify-between mb-1">
                  <span className="font-mono text-[9px] text-gray-500">Progression</span>
                  <span className="font-mono text-[9px] font-bold text-blue-400">{activeJob.progress}%</span>
                </div>
                <div className="h-[3px] bg-gray-950">
                  <div className="h-full bg-blue-500 transition-all" style={{ width: `${activeJob.progress}%` }} />
                </div>
              </div>

              {/* Stat grid */}
              {(activeJob.trainLoss !== null || activeJob.valLoss !== null || activeJob.valAccuracy !== null) && (
                <div className="grid grid-cols-3 gap-1.5 mb-3">
                  {[
                    { lbl: "Loss — train", val: activeJob.trainLoss?.toFixed(4) ?? "—",  accent: "text-blue-400"  },
                    { lbl: "Loss — val",   val: activeJob.valLoss?.toFixed(4)   ?? "—",  accent: "text-blue-400"  },
                    { lbl: "Acc — val",    val: activeJob.valAccuracy !== null ? `${(activeJob.valAccuracy * 100).toFixed(1)}%` : "—", accent: "text-green-400" },
                  ].map((s, i) => (
                    <div key={i} className="bg-gray-800/50 border border-gray-700/60 rounded p-2">
                      <div className="font-mono text-[9px] uppercase tracking-wide text-gray-600 mb-1">{s.lbl}</div>
                      <div className={`font-mono text-[17px] font-bold leading-none ${s.accent}`}>{s.val}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Logs — live SSE stream */}
              {(liveLog || activeJob.logs) && (
                <>
                  <div className="flex items-center justify-between mb-1.5 pb-1 border-b border-gray-800">
                    <span className="font-mono text-[9px] uppercase tracking-[.14em] text-gray-700">Logs temps réel</span>
                    {liveLog && <span className="flex items-center gap-1 text-[9px] text-blue-400 font-mono"><span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />SSE live</span>}
                  </div>
                  <div ref={liveLogRef} className="bg-gray-950 border border-gray-800 rounded px-2.5 py-2 font-mono text-[10px] text-gray-500 max-h-36 overflow-y-auto leading-5 whitespace-pre-wrap break-all">
                    {liveLog || activeJob.logs}
                  </div>
                </>
              )}
            </Panel>
          ) : recentJobs.length === 0 ? (
            <Panel title="Job d'entraînement">
              <EmptyState msg="Aucun job d'entraînement — lancez votre premier cycle avec « + Nouveau cycle »" />
            </Panel>
          ) : (
            /* Last completed job summary */
            <Panel
              title={
                <span className="flex items-center gap-2">
                  <span className={recentJobs[0].status === "DONE" ? "text-green-400" : "text-red-400"}>
                    {recentJobs[0].status === "DONE" ? "✓" : "✕"}
                  </span>
                  Job terminé — <span className="font-mono text-gray-300">{recentJobs[0].jobRef}</span>
                </span>
              }
              action={
                <span className="font-mono text-[9px] text-gray-500">{recentJobs[0].status}</span>
              }
            >
              <div className="text-[11px] text-gray-400 mb-1">
                {recentJobs[0].model ? `${recentJobs[0].model.name} ${recentJobs[0].model.version}` : "Modèle inconnu"}
              </div>
              {recentJobs[0].valAccuracy !== null && (
                <div className="font-mono text-[10px] text-green-400">
                  Acc val : {(recentJobs[0].valAccuracy! * 100).toFixed(1)}%
                </div>
              )}
              <div className="font-mono text-[9px] text-gray-600 mt-1">
                Terminé {recentJobs[0].finishedAt ? new Date(recentJobs[0].finishedAt).toLocaleString("fr-FR") : "—"}
              </div>
              {recentJobs[0].status === "DONE" && (
                <button
                  onClick={() => { setShowFlashDeployModal(true); setFlashDeployLog(""); setFlashDeployStatus("idle"); }}
                  className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wide bg-blue-900/30 text-blue-400 border border-blue-700/40 hover:bg-blue-900/50 transition-colors"
                >
                  ⚡ Flash USB
                </button>
              )}
            </Panel>
          )}

          {/* Comparison table — shown only when a DONE job exists */}
          {recentJobs.some((j) => j.status === "DONE") && (() => {
            const doneJob = recentJobs.find((j) => j.status === "DONE")!;
            const prod    = models.find((m) => m.status === "PROD" && m.type === doneJob.model?.type);
            return (
              <Panel title="Comparaison modèles" action={
                <span className="font-mono text-[9px] text-gray-500">{doneJob.jobRef}</span>
              }>
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      {["Métrique", "Actuel", "> Nouveau", "Delta"].map((h, i) => (
                        <th key={i} className={`text-left px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-wide border-b border-gray-800 ${i === 2 ? "text-blue-400" : "text-gray-600"}`}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      {
                        label: "Accuracy",
                        old: prod?.accuracy != null ? `${prod.accuracy.toFixed(1)}%` : "—",
                        nw:  doneJob.valAccuracy != null ? `${(doneJob.valAccuracy * 100).toFixed(1)}%` : "—",
                        deltaVal: prod?.accuracy != null && doneJob.valAccuracy != null
                          ? doneJob.valAccuracy * 100 - prod.accuracy : null,
                        unit: "%",
                      },
                      {
                        label: "Loss val",
                        old: "—",
                        nw:  doneJob.valLoss?.toFixed(4) ?? "—",
                        deltaVal: null,
                        unit: "",
                      },
                    ].map((row, i) => {
                      const win = row.deltaVal !== null ? row.deltaVal > 0 : null;
                      const deltaStr = row.deltaVal !== null
                        ? `${row.deltaVal > 0 ? "▲" : "▼"} ${row.deltaVal > 0 ? "+" : ""}${row.deltaVal.toFixed(1)}${row.unit}`
                        : "—";
                      return (
                        <tr key={i}>
                          <td className="px-2.5 py-2 text-[11px] text-gray-400 font-medium border-b border-gray-800">{row.label}</td>
                          <td className="px-2.5 py-2 font-mono text-[11px] text-gray-500 border-b border-gray-800">{row.old}</td>
                          <td className="px-2.5 py-2 font-mono text-[11px] text-blue-400 font-bold border-b border-gray-800">{row.nw}</td>
                          <td className={`px-2.5 py-2 font-mono text-[10px] border-b border-gray-800 ${win === null ? "text-gray-600" : win ? "text-green-400" : "text-red-400"}`}>
                            {deltaStr}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Panel>
            );
          })()}

          {/* Validation call-out — shown when a DONE job awaits validation */}
          {recentJobs.some((j) => j.status === "DONE") && (
            <div className="flex gap-3 items-start p-3 rounded border border-amber-700/40 bg-amber-900/10">
              <div className="text-amber-400 text-base flex-shrink-0 mt-0.5">!</div>
              <div className="flex-1">
                <div className="text-[11px] font-bold uppercase tracking-wide text-amber-400">
                  Point de décision humaine requis — Validation du modèle
                </div>
                <div className="text-[10px] text-gray-400 mt-1 leading-relaxed">
                  Comparez les métriques finales et décidez de promouvoir le modèle en STAGING ou de le rejeter.
                  Cette décision est journalisée dans l&apos;audit log avec horodatage et identifiant opérateur.
                </div>
                <div className="flex gap-2 mt-2.5 flex-wrap">
                  <button
                    onClick={() => handleValidate("PROMOTE")}
                    disabled={validating}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wide bg-green-900/30 text-green-400 border border-green-700/40 hover:bg-green-900/50 disabled:opacity-50 transition-colors"
                  >
                    ✓ Valider &amp; promouvoir en staging
                  </button>
                  <button
                    onClick={() => handleValidate("REJECT")}
                    disabled={validating}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wide bg-red-900/30 text-red-400 border border-red-700/40 hover:bg-red-900/50 disabled:opacity-50 transition-colors"
                  >
                    ✕ Rejeter &amp; archiver
                  </button>
                  <button
                    onClick={() => { setShowFlashDeployModal(true); setFlashDeployLog(""); setFlashDeployStatus("idle"); }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wide bg-blue-900/30 text-blue-400 border border-blue-700/40 hover:bg-blue-900/50 transition-colors"
                  >
                    ⚡ Flash USB
                  </button>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* RIGHT — Devices + Last deploy + Audit */}
        <div className="w-[272px] flex-shrink-0 border-l border-gray-800 overflow-y-auto p-3.5 flex flex-col gap-3">

          {/* Pulse devices */}
          <Panel title="Dispositifs Pulse" action={
            <span className="font-mono text-[9px] text-green-400">{onlineCount} / {devices.length} en ligne</span>
          }>
            <div className="font-mono text-[9px] uppercase tracking-[.14em] text-gray-700 mb-1.5 pb-1 border-b border-gray-800">
              Sélectionner pour déploiement
            </div>
            {loadingDevices ? (
              <EmptyState msg="Chargement…" />
            ) : devices.length === 0 ? (
              <EmptyState msg="Aucun dispositif enregistré" />
            ) : (
              devices.map(d => {
                const offline = !d.active;
                const sel = selectedDevices.has(d.id) && !offline;
                return (
                  <div
                    key={d.id}
                    onClick={() => toggleDevice(d.id, offline)}
                    className={`flex items-center gap-2 p-2 rounded mb-1.5 last:mb-0 border transition-all cursor-pointer
                      ${offline ? "opacity-40 cursor-not-allowed border-gray-800" : sel ? "border-blue-700/50 bg-blue-900/10" : "border-gray-800 hover:border-gray-700 hover:bg-gray-800/50"}`}
                  >
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${deviceDot(!offline, false)}`} />
                    <div className="font-mono text-[10px] font-bold w-14 flex-shrink-0 text-gray-400 truncate">{d.mqttClientId}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] text-gray-400 truncate">{d.name}</div>
                      <div className="font-mono text-[9px] text-gray-500 truncate">{d.latestModelId ?? "Aucun modèle"}</div>
                    </div>
                    <div className={`w-3.5 h-3.5 rounded flex-shrink-0 flex items-center justify-center border text-[8px] transition-all
                      ${sel ? "bg-blue-600 border-blue-600 text-white" : "border-gray-700 bg-gray-900"}`}>
                      {sel && "✓"}
                    </div>
                  </div>
                );
              })
            )}
            <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-gray-800">
              <span className="font-mono text-[9px] text-gray-500">{selectedDevices.size} sélectionné{selectedDevices.size > 1 ? "s" : ""}</span>
              <button
                disabled={selectedDevices.size === 0 || !selectedModel}
                onClick={() => setShowDeployModal(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wide bg-blue-600 text-white border border-blue-600 disabled:opacity-40 disabled:cursor-not-allowed hover:enabled:bg-blue-700 transition-colors"
              >
                ↑ Déployer OTA
              </button>
            </div>
          </Panel>

          {/* Last deployment */}
          <Panel title="Dernier déploiement OTA" action={
            <span className="font-mono text-[9px] text-gray-500">
              {latestDeploy?.deployRef ?? "—"}
            </span>
          }>
            {!latestDeploy ? (
              <EmptyState msg="Aucun déploiement effectué" />
            ) : (
              <>
                <div className="font-mono text-[9px] text-gray-700 mb-2">
                  {new Date(latestDeploy.deployedAt).toLocaleString("fr-FR")} · {latestDeploy.deviceIds.length} dispositif{latestDeploy.deviceIds.length > 1 ? "s" : ""}
                </div>
                {latestDeploy.deviceIds.map(devId => {
                  const result = latestDeploy.results?.[devId] ?? "pending";
                  return (
                    <div key={devId} className="flex items-center gap-2 py-1.5 border-b border-gray-800 last:border-b-0">
                      <span className="font-mono text-[10px] text-gray-500 w-14 flex-shrink-0 truncate">{devId}</span>
                      <div className="flex-1 h-[3px] bg-gray-950">
                        <div className={`h-full ${result === "ok" ? "bg-green-500" : result === "fail" ? "bg-red-500" : "bg-gray-700"}`} style={{ width: "100%" }} />
                      </div>
                      <span className={`font-mono text-[9px] uppercase w-14 text-right flex-shrink-0 ${result === "ok" ? "text-green-400" : result === "fail" ? "text-red-400" : "text-gray-600"}`}>
                        {result}
                      </span>
                    </div>
                  );
                })}
              </>
            )}
          </Panel>

          {/* Audit log */}
          <Panel title="Audit log" action={
            <button className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded border border-transparent transition-colors">
              Tout voir
            </button>
          }>
            {loadingAudit ? (
              <EmptyState msg="Chargement…" />
            ) : auditLog.length === 0 ? (
              <EmptyState msg="Aucune opération enregistrée" />
            ) : (
              auditLog.slice(0, 8).map((entry) => (
                <div key={entry.id} className="flex gap-2.5 py-1.5 border-b border-gray-800 last:border-b-0">
                  <span className="font-mono text-[9px] text-gray-700 flex-shrink-0 w-9 pt-0.5">
                    {formatAuditTime(entry.createdAt)}
                  </span>
                  <span className="text-[10px] text-gray-400 leading-snug">
                    {entry.label ?? `${entry.actor} — ${entry.action}`}
                  </span>
                </div>
              ))
            )}
          </Panel>

        </div>
      </div>

      {/* ── Modal — Nouveau cycle ──────────────────────────────────────────── */}
      {showTrainModal && (
        <Modal title="+ Nouveau cycle d'entraînement" onClose={() => setShowTrainModal(false)}>

          {/* ── Step 1: Data source ──────────────────────────────────────── */}
          <p className="font-mono text-[9px] uppercase tracking-wide text-gray-500 mb-2">1 · Source de données</p>

          {/* Tab switcher */}
          <div className="flex gap-1 mb-3 bg-gray-800/60 rounded-lg p-0.5">
            {(["csv", "capture", "synthetic"] as const).map((tab) => {
              const labels: Record<typeof tab, string> = { csv: "📁 CSV", capture: "📡 MQTT DB", synthetic: "🔬 Synthétique" };
              return (
                <button key={tab} onClick={() => setDataTab(tab)}
                  className={`flex-1 py-1.5 rounded text-[10px] font-semibold transition-colors ${
                    dataTab === tab ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  {labels[tab]}
                </button>
              );
            })}
          </div>

          {/* ── CSV Upload ──────────────────────────────────────────────── */}
          {dataTab === "csv" && (
            <div className="mb-3 space-y-2">
              <p className="text-[10px] text-gray-400">Importez votre dataset CSV. La première ligne doit être l&apos;en-tête.</p>
              <div className="flex gap-2">
                <label className="flex-1 cursor-pointer">
                  <div className={`border-2 border-dashed rounded-lg px-3 py-3 text-center transition-colors ${
                    uploadFile ? "border-blue-600/50 bg-blue-900/10" : "border-gray-700 hover:border-gray-600"
                  }`}>
                    <p className="text-[10px] text-gray-300 font-medium">{uploadFile ? uploadFile.name : "Cliquez ou glissez un fichier .csv"}</p>
                    {uploadFile && <p className="text-[9px] text-gray-500 mt-0.5">{(uploadFile.size / 1024).toFixed(0)} KB</p>}
                  </div>
                  <input type="file" accept=".csv" className="hidden"
                    onChange={(e) => { setUploadFile(e.target.files?.[0] ?? null); setUploadResult(null); }} />
                </label>
                <button onClick={handleUploadCsv} disabled={!uploadFile || uploading}
                  className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-semibold disabled:opacity-40 self-center transition-colors">
                  {uploading ? "…" : "Analyser"}
                </button>
              </div>
              {uploadError && <p className="text-[10px] text-red-400">{uploadError}</p>}
              {uploadResult && (
                <div className="rounded border border-green-700/40 bg-green-900/10 p-2.5 space-y-1">
                  <p className="text-[10px] text-green-400 font-semibold">✓ {uploadResult.rows} lignes · colonnes : {uploadResult.columns.join(", ")}</p>
                  <div className="font-mono text-[9px] text-gray-500 max-h-16 overflow-y-auto">
                    {uploadResult.preview.map((l, i) => <div key={i}>{l}</div>)}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── MQTT DB Capture ─────────────────────────────────────────── */}
          {dataTab === "capture" && (
            <div className="mb-3 space-y-2">
              <p className="text-[10px] text-gray-400">Exportez les lectures stockées en base pour les utiliser comme dataset d&apos;entraînement.</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="font-mono text-[9px] uppercase tracking-wide text-gray-500 block mb-1">Appareil (optionnel)</label>
                  <select value={captureDevice} onChange={(e) => setCaptureDevice(e.target.value)}
                    className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500">
                    <option value="">Tous les appareils</option>
                    {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="font-mono text-[9px] uppercase tracking-wide text-gray-500 block mb-1">Limite (lignes)</label>
                  <input type="number" defaultValue={5000} min={50} max={20000}
                    className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="font-mono text-[9px] uppercase tracking-wide text-gray-500 block mb-1">Depuis</label>
                  <input type="date" value={captureFrom} onChange={(e) => setCaptureFrom(e.target.value)}
                    className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="font-mono text-[9px] uppercase tracking-wide text-gray-500 block mb-1">Jusqu&apos;à</label>
                  <input type="date" value={captureTo} onChange={(e) => setCaptureTo(e.target.value)}
                    className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500" />
                </div>
              </div>
              <button onClick={handleCapture} disabled={capturing}
                className="w-full py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-semibold disabled:opacity-40 transition-colors">
                {capturing ? "Export en cours…" : "Exporter depuis la BDD"}
              </button>
              {captureError && <p className="text-[10px] text-red-400">{captureError}</p>}
              {captureResult && (
                <p className="text-[10px] text-green-400 font-semibold">✓ {captureResult.rows} lectures exportées — prêt pour l&apos;entraînement</p>
              )}
            </div>
          )}

          {/* ── Synthetic ────────────────────────────────────────────────── */}
          {dataTab === "synthetic" && (
            <div className="mb-3 space-y-2">
              <p className="text-[10px] text-gray-400">Forge génère un signal synthétique avec anomalies injectées. Idéal pour valider un algo rapidement.</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="font-mono text-[9px] uppercase tracking-wide text-gray-500 block mb-1">Signal</label>
                  <select value={synthSignal} onChange={(e) => setSynthSignal(e.target.value as typeof synthSignal)}
                    className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500">
                    <option value="sine">Sinusoïdal</option>
                    <option value="random_walk">Marche aléatoire</option>
                    <option value="constant">Constant</option>
                  </select>
                </div>
                <div>
                  <label className="font-mono text-[9px] uppercase tracking-wide text-gray-500 block mb-1">N échantillons</label>
                  <input type="number" value={synthSamples} min={50} max={50000}
                    onChange={(e) => setSynthSamples(parseInt(e.target.value, 10) || 1000)}
                    className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="font-mono text-[9px] uppercase tracking-wide text-gray-500 block mb-1">Bruit (σ)</label>
                  <input type="number" value={synthNoise} min={0.01} max={5} step={0.01}
                    onChange={(e) => setSynthNoise(parseFloat(e.target.value) || 0.1)}
                    className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="font-mono text-[9px] uppercase tracking-wide text-gray-500 block mb-1">Taux anomalie</label>
                  <input type="number" value={synthAnomalyRate} min={0} max={0.5} step={0.01}
                    onChange={(e) => setSynthAnomalyRate(parseFloat(e.target.value) || 0.05)}
                    className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500" />
                </div>
              </div>
              <p className="text-[9px] text-green-400">✓ Prêt — aucune importation nécessaire</p>
            </div>
          )}

          {/* ── Step 2: Algorithm ───────────────────────────────────────── */}
          <div className="border-t border-gray-800 pt-3 mb-2.5">
            <p className="font-mono text-[9px] uppercase tracking-wide text-gray-500 mb-2">2 · Algorithme de détection</p>
            {algorithms.length === 0 ? (
              <div className="font-mono text-[9px] text-gray-600 py-2">Chargement…</div>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {algorithms.map((algo) => (
                  <button key={algo.id} type="button" onClick={() => setSelectedAlgo(algo.id)}
                    className={`text-left p-2 rounded border transition-all ${
                      selectedAlgo === algo.id ? "border-blue-700/60 bg-blue-900/15" : "border-gray-800 hover:border-gray-700 hover:bg-gray-800/40"
                    }`}>
                    <div className="text-[10px] font-semibold text-gray-100">{algo.name}</div>
                    <div className="font-mono text-[8px] text-gray-600 mt-0.5">
                      RAM {algo.ram_bytes_estimate} · {algo.export_format}
                      {algo.requires && <span className="ml-1 text-amber-600/80"> · {algo.requires}</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── Step 3: Profile ─────────────────────────────────────────── */}
          <div className="border-t border-gray-800 pt-3 mb-3">
            <p className="font-mono text-[9px] uppercase tracking-wide text-gray-500 mb-1">3 · Profil d&apos;entraînement</p>
            <select value={trainProfile} onChange={(e) => setTrainProfile(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500">
              <option value="standard">Standard — 50 epochs</option>
              <option value="rapide">Rapide — 25 epochs</option>
              <option value="precis">Précis — 100 epochs</option>
            </select>
          </div>

          <div className="bg-amber-900/10 border border-amber-700/40 rounded px-3 py-2 text-[10px] text-amber-400 mb-3 leading-relaxed">
            Validation humaine requise avant déploiement. Cette action sera journalisée.
          </div>

          <div className="flex gap-2 justify-end pt-3 border-t border-gray-800">
            <button onClick={() => setShowTrainModal(false)}
              className="px-3 py-1.5 rounded text-[11px] font-semibold uppercase tracking-wide border border-gray-700 text-gray-400 hover:border-gray-600 hover:bg-gray-800 transition-colors">
              Annuler
            </button>
            <button onClick={handleLaunchJob}
              disabled={submittingJob || !dataSourceReady()}
              title={!dataSourceReady() ? "Importez d'abord votre dataset" : ""}
              className="px-3 py-1.5 rounded text-[11px] font-semibold uppercase tracking-wide bg-blue-600 hover:bg-blue-700 text-white border border-blue-600 transition-colors disabled:opacity-60 disabled:cursor-wait">
              {submittingJob ? "Lancement…" : "Lancer l'entraînement"}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Modal — Déploiement OTA ────────────────────────────────────────── */}
      {showDeployModal && selectedModelObj && (
        <Modal title="↑ Confirmer le déploiement OTA" onClose={() => setShowDeployModal(false)}>
          <p className="text-[11px] text-gray-400 mb-3 leading-relaxed">
            Déploiement de <b className="text-gray-100">{selectedModelObj.name} {selectedModelObj.version}</b> sur{" "}
            <b className="text-gray-100">{selectedDevices.size} dispositif{selectedDevices.size > 1 ? "s" : ""} Pulse</b> sélectionné{selectedDevices.size > 1 ? "s" : ""}.
          </p>
          <div className="bg-amber-900/10 border border-amber-700/40 rounded px-3 py-2 text-[10px] text-amber-400 mb-3 leading-relaxed">
            Action irréversible. En cas d&apos;échec, rollback automatique vers la version précédente.
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
            <button
              onClick={handleDeploy}
              disabled={submittingDeploy}
              className="px-3 py-1.5 rounded text-[11px] font-semibold uppercase tracking-wide bg-red-900/30 text-red-400 border border-red-700/40 hover:bg-red-900/50 transition-colors disabled:opacity-60 disabled:cursor-wait"
            >
              {submittingDeploy ? "Déploiement…" : "Confirmer le déploiement"}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Modal — Flash USB depuis job Forge ────────────────────────────── */}
      {showFlashDeployModal && (
        <Modal title="⚡ Flash USB — déploiement firmware" onClose={() => setShowFlashDeployModal(false)}>
          <p className="text-[11px] text-gray-400 mb-3 leading-relaxed">
            Génère <code className="text-[10px] bg-gray-800 px-1 rounded">config.h</code> (WiFi + MQTT + deviceId)
            et flash le firmware via PlatformIO sur le port USB sélectionné.
          </p>

          <div className="mb-2.5">
            <label className="font-mono text-[9px] uppercase tracking-wide text-gray-500 block mb-1">Device cible</label>
            <select
              value={flashDeployDeviceId}
              onChange={(e) => setFlashDeployDeviceId(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500"
            >
              <option value="">— Sélectionner un device —</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>{d.name} ({d.mqttClientId})</option>
              ))}
            </select>
          </div>

          <div className="mb-3">
            <label className="font-mono text-[9px] uppercase tracking-wide text-gray-500 block mb-1">Port série</label>
            <input
              type="text"
              value={flashDeployPort}
              onChange={(e) => setFlashDeployPort(e.target.value)}
              placeholder="COM4"
              className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500"
            />
          </div>

          {/* Flash log terminal */}
          {(flashDeployLog || flashDeployStatus !== "idle") && (
            <div className="mb-3 rounded border border-gray-800 bg-gray-950 overflow-hidden">
              <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-gray-800">
                <span className="font-mono text-[8px] uppercase tracking-widest text-gray-600">PlatformIO</span>
                {flashDeployStatus === "running" && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
                {flashDeployStatus === "ok"      && <span className="text-[9px] text-green-400 font-mono">✓ OK</span>}
                {flashDeployStatus === "error"   && <span className="text-[9px] text-red-400 font-mono">✕ Erreur</span>}
              </div>
              <div ref={flashLogRef} className="p-2 font-mono text-[9px] text-gray-500 max-h-40 overflow-y-auto whitespace-pre-wrap break-all leading-5">
                {flashDeployLog || "Lancement…"}
              </div>
            </div>
          )}

          <div className="flex gap-2 justify-end pt-3 border-t border-gray-800">
            <button
              onClick={() => setShowFlashDeployModal(false)}
              className="px-3 py-1.5 rounded text-[11px] font-semibold uppercase tracking-wide border border-gray-700 text-gray-400 hover:border-gray-600 hover:bg-gray-800 transition-colors"
            >
              Fermer
            </button>
            <button
              onClick={handleFlashDeploy}
              disabled={flashDeployStatus === "running" || !flashDeployDeviceId}
              className={`px-3 py-1.5 rounded text-[11px] font-semibold uppercase tracking-wide border transition-colors disabled:opacity-50 ${
                flashDeployStatus === "ok"
                  ? "bg-green-700 border-green-600 text-white"
                  : "bg-blue-600 border-blue-600 text-white hover:bg-blue-700"
              }`}
            >
              {flashDeployStatus === "running" ? "⟳ Flash en cours…" : "⚡ Compiler & Flasher"}
            </button>
          </div>
        </Modal>
      )}

    </div>
  );
}

// ── Reusable sub-components ───────────────────────────────────────────────────

function EmptyState({ msg, error }: { msg: string; error?: boolean }) {
  return (
    <div className={`font-mono text-[9px] py-2 ${error ? "text-red-500" : "text-gray-700"}`}>
      {msg}
    </div>
  );
}

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
  model: ApiModel;
  selected: boolean;
  onClick: () => void;
  dimmed?: boolean;
}) {
  const meta = [
    model.sizeKb    != null ? `${model.sizeKb.toFixed(0)} KB`          : null,
    model.latencyMs != null ? `${model.latencyMs.toFixed(1)} ms`        : null,
    model.accuracy  != null ? `${model.accuracy.toFixed(1)}%`           : null,
  ].filter(Boolean).join(" · ");

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
        <div className="font-mono text-[9px] text-gray-500 mt-0.5 truncate">
          {model.version}{meta ? ` · ${meta}` : ""}
        </div>
      </div>
      <span className={`font-mono text-[8px] uppercase tracking-wide px-1.5 py-0.5 rounded border flex-shrink-0 ${statusBadge(model.status)}`}>
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
