"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { ReadingChart } from "@/components/ReadingChart";
import { AlertList } from "@/components/AlertList";
import { DeviceCard } from "@/components/DeviceCard";
import { FleetPanel } from "@/components/FleetPanel";
import { WorkerMap } from "@/components/WorkerMap";
import { AlertTimeline } from "@/components/AlertTimeline";
import { FatigueCard } from "@/components/FatigueCard";
import { HRVChart } from "@/components/HRVChart";
import { TempCard } from "@/components/TempCard";
import { TemperatureChart } from "@/components/TemperatureChart";
import FleetHealth from "@/components/FleetHealth";
import WorkerDetail from "@/components/WorkerDetail";
import { FleetAlertTimeline } from "@/components/FleetAlertTimeline";
import ForgeTab    from "@/components/ForgeTab";
import FlashPanel  from "@/components/FlashPanel";
import { Sidebar, type ViewType } from "@/components/Sidebar";
import { Topbar }    from "@/components/Topbar";
import { Breadcrumb } from "@/components/Breadcrumb";

interface SerialPort { name: string; description: string }

/** Returns true if the port looks like an ESP32 / CH340 adapter. */
function looksLikeEsp(p: SerialPort) {
  const d = p.description.toLowerCase();
  return d.includes("ch340") || d.includes("ch341") || d.includes("cp210") ||
         d.includes("ftdi") || d.includes("usb-serial") || d.includes("usb serial") ||
         d.includes("espressif") || d.includes("uart");
}

interface Device {
  id: string;
  name: string;
  mqttClientId: string;
  location: string | null;
  active: boolean;
  lastReadingAt: string | null;
  readingCount: number;
  latestFirmware: string | null;
  latestModelId: string | null;
  latestUnit: string | null;
  latestLabel: string | null;
}

interface DeviceForm {
  name: string;
  mqttClientId: string;
  location: string;
}

export default function DashboardPage() {
  const router = useRouter();
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [view, setView] = useState<ViewType>("fleet");
  const [clock, setClock] = useState<string>("");

  // Device CRUD modal
  const [showDeviceModal, setShowDeviceModal] = useState(false);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [deviceForm, setDeviceForm] = useState<DeviceForm>({ name: "", mqttClientId: "", location: "" });
  const [deviceFormError, setDeviceFormError] = useState<string | null>(null);
  const [submittingDevice, setSubmittingDevice] = useState(false);

  // Confirm delete modal
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Janitor result toast (auto-dismiss after 4s)
  const [janitorResult, setJanitorResult] = useState<{ deactivated: number; purged: number } | null>(null);
  const janitorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // USB device detection
  const [detectedPort, setDetectedPort] = useState<SerialPort | null>(null);
  const [flashPreport, setFlashPreport] = useState<string>("");
  const prevPortNames = useRef<Set<string>>(new Set());
  const detectionIgnored = useRef<Set<string>>(new Set());

  useEffect(() => {
    setClock(new Date().toLocaleString("fr-FR"));
    const id = setInterval(() => setClock(new Date().toLocaleString("fr-FR")), 1000);
    return () => clearInterval(id);
  }, []);

  // Poll for USB serial ports every 3s — trigger toast on new port
  useEffect(() => {
    let active = true;
    const poll = () => {
      if (!active) return;
      apiFetch("/api/flash/ports")
        .then(async (r) => {
          if (!r.ok || !active) return;
          const ports: SerialPort[] = await r.json();
          const prev = prevPortNames.current;
          const added = ports.filter((p) => !prev.has(p.name) && !detectionIgnored.current.has(p.name));
          // Auto-pick ESP32-looking port; fallback to first added
          if (added.length > 0) {
            const best = added.find(looksLikeEsp) ?? added[0];
            setDetectedPort(best);
          }
          // If currently shown port disconnected → hide toast
          setDetectedPort((cur) => {
            if (cur && !ports.some((p) => p.name === cur.name)) return null;
            return cur;
          });
          prevPortNames.current = new Set(ports.map((p) => p.name));
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const fetchDevices = useCallback(() => {
    apiFetch("/api/devices")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Device[]) => {
        setDevices((prev) => {
          if (prev.length === 0 && data.length > 0) {
            setSelectedId((s) => s ?? data[0].id);
            if (data.length === 1) setView("detail");
          }
          return data;
        });
        setFetchError(null);
      })
      .catch((err: unknown) => {
        setFetchError(err instanceof Error ? err.message : "Erreur réseau");
      });
  }, []);

  useEffect(() => {
    fetchDevices();
    const interval = setInterval(fetchDevices, 5_000);
    return () => clearInterval(interval);
  }, [fetchDevices]);

  const selectDevice = (id: string) => { setSelectedId(id); setView("detail"); };
  const selectWorker = (id: string) => { setSelectedId(id); setView("worker"); };

  const openAddDevice = () => {
    setEditingDeviceId(null);
    setDeviceForm({ name: "", mqttClientId: "", location: "" });
    setDeviceFormError(null);
    setShowDeviceModal(true);
  };

  const openEditDevice = (d: Device) => {
    setEditingDeviceId(d.id);
    setDeviceForm({ name: d.name, mqttClientId: d.mqttClientId, location: d.location ?? "" });
    setDeviceFormError(null);
    setShowDeviceModal(true);
  };

  const handleDeviceSubmit = async () => {
    setDeviceFormError(null);
    if (!deviceForm.name.trim() || !deviceForm.mqttClientId.trim()) {
      setDeviceFormError("Nom et Client MQTT sont obligatoires");
      return;
    }
    setSubmittingDevice(true);
    try {
      const res = editingDeviceId
        ? await apiFetch(`/api/devices/${editingDeviceId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: deviceForm.name.trim(), location: deviceForm.location.trim() || undefined }),
          })
        : await apiFetch("/api/devices", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: deviceForm.name.trim(),
              mqttClientId: deviceForm.mqttClientId.trim(),
              location: deviceForm.location.trim() || undefined,
            }),
          });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setDeviceFormError((err as { error?: string }).error ?? `Erreur ${res.status}`);
        return;
      }
      setShowDeviceModal(false);
    } finally {
      setSubmittingDevice(false);
    }
  };

  const handleDeleteDevice = async (id: string) => {
    await apiFetch(`/api/devices/${id}`, { method: "DELETE" });
    setConfirmDeleteId(null);
    setShowDeviceModal(false);
    setDevices((prev) => prev.filter((d) => d.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const handleJanitor = async () => {
    const res = await apiFetch("/api/devices/janitor", { method: "POST" });
    if (res.ok) {
      const r = await res.json() as { deactivated: number; purged: number };
      setJanitorResult(r);
      if (janitorTimer.current) clearTimeout(janitorTimer.current);
      janitorTimer.current = setTimeout(() => setJanitorResult(null), 4_000);
    }
  };

  const selectedDevice = devices.find((d) => d.id === selectedId) ?? null;

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100 overflow-hidden">

      {/* ── Sidebar ─────────────────────────────────────────────────── */}
      <Sidebar
        view={view}
        onViewChange={setView}
        hasDevices={devices.length > 0}
      />

      {/* ── Main column ─────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0">

        <Topbar
          clock={clock}
          onAddDevice={openAddDevice}
          onJanitor={handleJanitor}
          onLogout={() => apiFetch("/api/auth/logout", { method: "POST" }).finally(() => router.push("/login"))}
          janitorResult={janitorResult}
        />

        <Breadcrumb view={view} selectedDevice={selectedDevice} />

        {/* ── Scrollable content ────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto p-6">

          {/* Error banner */}
          {fetchError && (
            <div className="flex items-center gap-3 mb-6 px-4 py-3 rounded-lg bg-red-950/40 border border-red-800/50 text-sm">
              <span className="text-red-400 flex-1">Erreur chargement capteurs : {fetchError}</span>
              <button
                onClick={fetchDevices}
                className="shrink-0 text-xs px-2.5 py-1 rounded border border-red-700 text-red-400 hover:bg-red-900/30 transition-colors"
              >
                Réessayer
              </button>
            </div>
          )}

          {/* Empty state */}
          {!fetchError && devices.length === 0 && view !== "forge" && view !== "flash" && (
            <div className="max-w-md mx-auto mt-20 text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-gray-800 flex items-center justify-center mx-auto">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 text-gray-500">
                  <path d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01M4.929 7.929a9.5 9.5 0 0114.142 0M2 5l1.5 1.5M22 5l-1.5 1.5" strokeLinecap="round" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-white">Aucun capteur enregistré</h2>
              <p className="text-gray-400 text-sm">Enregistrez votre premier capteur puis démarrez la transmission MQTT.</p>
              <button
                onClick={openAddDevice}
                className="px-5 py-2.5 rounded-lg bg-white text-gray-900 text-sm font-semibold hover:bg-gray-100 transition-colors"
              >
                + Ajouter un capteur
              </button>
              <details className="text-left mt-2">
                <summary className="text-xs text-gray-600 cursor-pointer hover:text-gray-400 transition-colors list-none flex items-center gap-1">
                  <svg viewBox="0 0 12 12" className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M4 2l4 4-4 4" strokeLinecap="round" />
                  </svg>
                  Voir les commandes de démarrage
                </summary>
                <div className="mt-3 space-y-3">
                  <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
                    <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-2">Simuler (sans hardware)</p>
                    <pre className="text-xs text-blue-400 font-mono bg-gray-950 rounded p-2 overflow-x-auto">uv run --with paho-mqtt scripts/demo_mqtt.py</pre>
                  </div>
                  <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
                    <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-2">Flasher ESP32</p>
                    <pre className="text-xs text-yellow-400 font-mono bg-gray-950 rounded p-2 overflow-x-auto">{"# Ou utiliser l'onglet Flash →\npio run --target upload --environment zscore_demo"}</pre>
                  </div>
                </div>
              </details>
            </div>
          )}

          {/* Forge */}
          {view === "forge" && <ForgeTab />}

          {/* Flash */}
          {view === "flash" && <FlashPanel preselectedPort={flashPreport} />}

          {/* Fleet */}
          {view === "fleet" && devices.length > 0 && (
            <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
              <div className="xl:col-span-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 content-start">
                {devices.map((d) => (
                  <FleetPanel
                    key={d.id}
                    deviceId={d.id}
                    deviceName={d.name}
                    mqttClientId={d.mqttClientId}
                    location={d.location}
                    readingCount={d.readingCount}
                    onSelect={() => selectDevice(d.id)}
                  />
                ))}
              </div>
              <div className="xl:col-span-1 min-h-[400px]">
                <FleetAlertTimeline />
              </div>
            </div>
          )}

          {/* PTI */}
          {view === "pti" && (
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
              <div className="xl:col-span-2">
                <WorkerMap onSelectWorker={selectWorker} />
              </div>
              <div>
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">Chronologie alertes</h2>
                <AlertTimeline />
              </div>
            </div>
          )}

          {/* Fatigue */}
          {view === "fatigue" && devices.length > 0 && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-6">
                {devices.map((d) => (
                  <FatigueCard
                    key={d.id}
                    deviceId={d.id}
                    deviceName={d.name}
                    location={d.location}
                    selected={d.id === selectedId}
                    onSelect={() => setSelectedId(d.id)}
                  />
                ))}
              </div>
              {selectedId && <HRVChart deviceId={selectedId} />}
            </>
          )}

          {/* Thermique */}
          {view === "thermique" && devices.length > 0 && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-6">
                {devices.map((d) => (
                  <TempCard
                    key={d.id}
                    deviceId={d.id}
                    deviceName={d.name}
                    location={d.location}
                    selected={d.id === selectedId}
                    onSelect={() => setSelectedId(d.id)}
                  />
                ))}
              </div>
              {selectedId && <TemperatureChart deviceId={selectedId} />}
            </>
          )}

          {/* Santé */}
          {view === "sante" && <FleetHealth onSelectWorker={selectWorker} />}

          {/* Worker */}
          {view === "worker" && selectedId && (
            <WorkerDetail deviceId={selectedId} onBack={() => setView("sante")} />
          )}

          {/* Detail */}
          {view === "detail" && devices.length > 0 && (
            <>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Capteurs actifs</h2>
                {selectedDevice && (
                  <button
                    onClick={() => openEditDevice(selectedDevice)}
                    className="text-xs text-gray-600 hover:text-gray-300 border border-gray-800 hover:border-gray-600 rounded px-2 py-1 transition-colors"
                  >
                    Modifier / Supprimer
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
                {devices.map((d) => (
                  <DeviceCard
                    key={d.id}
                    device={d}
                    selected={d.id === selectedId}
                    onClick={() => setSelectedId(d.id)}
                  />
                ))}
              </div>
              {selectedId && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <div className="lg:col-span-2">
                    <ReadingChart deviceId={selectedId} />
                  </div>
                  <div>
                    <AlertList deviceId={selectedId} />
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* ── Device create/edit modal ───────────────────────────────── */}
      {showDeviceModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setShowDeviceModal(false)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-white mb-4">
              {editingDeviceId ? "Modifier le capteur" : "Ajouter un capteur"}
            </h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Nom</label>
                <input
                  autoFocus
                  type="text"
                  value={deviceForm.name}
                  onChange={(e) => setDeviceForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="ESP32-CAM 001"
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  Client MQTT
                  {editingDeviceId && <span className="ml-1.5 text-gray-600">(non modifiable)</span>}
                </label>
                <input
                  type="text"
                  value={deviceForm.mqttClientId}
                  onChange={(e) => setDeviceForm((f) => ({ ...f, mqttClientId: e.target.value }))}
                  placeholder="esp32-cam-001"
                  disabled={!!editingDeviceId}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500 disabled:opacity-40"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Emplacement</label>
                <input
                  type="text"
                  value={deviceForm.location}
                  onChange={(e) => setDeviceForm((f) => ({ ...f, location: e.target.value }))}
                  placeholder="Bureau, Zone A…"
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
                />
              </div>
            </div>
            {deviceFormError && <p className="text-red-400 text-xs mt-3">{deviceFormError}</p>}
            <div className="flex gap-2 mt-5">
              <button
                onClick={handleDeviceSubmit}
                disabled={submittingDevice}
                className="flex-1 py-2 rounded bg-white text-gray-900 text-sm font-semibold hover:bg-gray-100 disabled:opacity-50 transition-colors"
              >
                {submittingDevice ? "En cours…" : editingDeviceId ? "Enregistrer" : "Créer"}
              </button>
              {editingDeviceId && (
                <button
                  onClick={() => { setShowDeviceModal(false); setConfirmDeleteId(editingDeviceId); }}
                  className="px-3 py-2 rounded border border-red-700/50 text-red-400 text-sm hover:bg-red-900/20 transition-colors"
                >
                  Supprimer
                </button>
              )}
              <button
                onClick={() => setShowDeviceModal(false)}
                className="px-3 py-2 rounded border border-gray-700 text-gray-400 text-sm hover:border-gray-500 transition-colors"
              >
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── USB device detection toast ────────────────────────────── */}
      {detectedPort && (
        <div className="fixed bottom-5 right-5 z-50 w-80 rounded-xl border border-gray-700 bg-gray-900 shadow-2xl overflow-hidden animate-in slide-in-from-bottom-3">
          {/* top accent bar */}
          <div className="h-0.5 bg-gradient-to-r from-green-500 to-blue-500" />
          <div className="p-4">
            <div className="flex items-start gap-3">
              {/* icon */}
              <div className="w-8 h-8 rounded-lg bg-green-900/40 border border-green-700/50 flex items-center justify-center shrink-0 mt-0.5">
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4 text-green-400">
                  <rect x="7" y="1" width="6" height="8" rx="1" />
                  <path d="M10 9v5M7 17h6M10 14l-2 3h4l-2-3z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white">
                  Appareil détecté
                </p>
                <p className="text-xs text-green-400 font-mono mt-0.5 truncate">
                  {detectedPort.name}
                </p>
                <p className="text-[10px] text-gray-500 truncate mt-0.5">
                  {detectedPort.description}
                </p>
              </div>
              <button
                onClick={() => {
                  detectionIgnored.current.add(detectedPort.name);
                  setDetectedPort(null);
                }}
                className="text-gray-600 hover:text-gray-300 transition-colors shrink-0"
              >
                <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2 2l8 8M10 2l-8 8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => {
                  setFlashPreport(detectedPort.name);
                  setView("flash");
                  detectionIgnored.current.add(detectedPort.name);
                  setDetectedPort(null);
                }}
                className="flex-1 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors"
              >
                ⚡ Flash
              </button>
              <button
                onClick={() => {
                  openAddDevice();
                  detectionIgnored.current.add(detectedPort.name);
                  setDetectedPort(null);
                }}
                className="flex-1 py-1.5 rounded border border-gray-700 hover:border-gray-500 text-gray-300 text-xs font-semibold transition-colors"
              >
                + Monitorer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm delete modal ───────────────────────────────────── */}
      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-gray-900 border border-red-800/50 rounded-xl p-6 w-full max-w-sm shadow-2xl">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 rounded-full bg-red-900/40 border border-red-700/50 flex items-center justify-center shrink-0">
                <svg viewBox="0 0 16 16" className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M8 5v4M8 11v.5" strokeLinecap="round" />
                  <path d="M7 2l-5 9h12L9 2H7z" strokeLinejoin="round" />
                </svg>
              </div>
              <h3 className="text-base font-semibold text-white">Supprimer ce capteur ?</h3>
            </div>
            <p className="text-sm text-gray-400 mb-5">
              Toutes les lectures et alertes associées seront définitivement supprimées. Cette action est irréversible.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="px-3 py-2 rounded border border-gray-700 text-gray-400 text-sm hover:border-gray-500 transition-colors"
              >
                Annuler
              </button>
              <button
                onClick={() => void handleDeleteDevice(confirmDeleteId)}
                className="px-4 py-2 rounded bg-red-700 hover:bg-red-600 text-white text-sm font-semibold transition-colors"
              >
                Supprimer définitivement
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
