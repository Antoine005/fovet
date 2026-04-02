"use client";

import { useEffect, useState } from "react";
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
import ForgeTab from "@/components/ForgeTab";

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
  const [view, setView] = useState<"fleet" | "detail" | "pti" | "fatigue" | "thermique" | "sante" | "worker" | "forge">("fleet");
  const [clock, setClock] = useState<string>("");

  // Device CRUD modal
  const [showDeviceModal, setShowDeviceModal] = useState(false);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [deviceForm, setDeviceForm] = useState<DeviceForm>({ name: "", mqttClientId: "", location: "" });
  const [deviceFormError, setDeviceFormError] = useState<string | null>(null);
  const [submittingDevice, setSubmittingDevice] = useState(false);

  useEffect(() => {
    setClock(new Date().toLocaleString("fr-FR"));
    const id = setInterval(() => setClock(new Date().toLocaleString("fr-FR")), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let initialised = false;

    function fetchDevices() {
      apiFetch("/api/devices")
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data: Device[]) => {
          setDevices(data);
          if (!initialised) {
            initialised = true;
            if (data.length > 0) setSelectedId((prev) => prev ?? data[0].id);
            if (data.length === 1) setView("detail");
          }
          setFetchError(null);
        })
        .catch((err: unknown) => {
          setFetchError(err instanceof Error ? err.message : "Erreur réseau");
        });
    }

    fetchDevices();
    const interval = setInterval(fetchDevices, 5_000);
    return () => clearInterval(interval);
  }, [router]);

  const selectDevice = (id: string) => {
    setSelectedId(id);
    setView("detail");
  };

  const selectWorker = (id: string) => {
    setSelectedId(id);
    setView("worker");
  };

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
    if (!confirm("Supprimer ce capteur et toutes ses données ?")) return;
    await apiFetch(`/api/devices/${id}`, { method: "DELETE" });
  };

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Ardent Watch
          </h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Supervision temps réel — Ardent Pulse
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border border-gray-800 overflow-hidden text-xs">
            {devices.length > 0 && (
              <>
                <button
                  onClick={() => setView("fleet")}
                  className={`px-3 py-1.5 transition-colors ${
                    view === "fleet" ? "bg-gray-800 text-white" : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  Flotte
                </button>
                <button
                  onClick={() => setView("detail")}
                  className={`px-3 py-1.5 transition-colors ${
                    view === "detail" ? "bg-gray-800 text-white" : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  Détail
                </button>
                <button
                  onClick={() => setView("pti")}
                  className={`px-3 py-1.5 transition-colors ${
                    view === "pti" ? "bg-gray-800 text-white" : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  PTI
                </button>
                <button
                  onClick={() => setView("fatigue")}
                  className={`px-3 py-1.5 transition-colors ${
                    view === "fatigue" ? "bg-gray-800 text-white" : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  Fatigue
                </button>
                <button
                  onClick={() => setView("thermique")}
                  className={`px-3 py-1.5 transition-colors ${
                    view === "thermique" ? "bg-gray-800 text-white" : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  Thermique
                </button>
                <button
                  onClick={() => setView("sante")}
                  className={`px-3 py-1.5 transition-colors ${
                    view === "sante" ? "bg-gray-800 text-white" : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  Santé
                </button>
              </>
            )}
            <button
              onClick={() => setView("forge")}
              className={`px-3 py-1.5 transition-colors ${
                view === "forge" ? "bg-gray-800 text-white" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              Forge
            </button>
          </div>
          <span className="text-xs text-gray-500 font-mono">{clock}</span>
          <button
            onClick={openAddDevice}
            className="text-xs px-2.5 py-1.5 rounded border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-colors"
          >
            + Capteur
          </button>
          <button
            onClick={() => {
              apiFetch("/api/auth/logout", { method: "POST" }).finally(() => {
                router.push("/login");
              });
            }}
            className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
          >
            Déconnexion
          </button>
        </div>
      </header>

      {fetchError && (
        <p className="text-red-400 text-sm mb-6">
          Erreur chargement capteurs : {fetchError}
        </p>
      )}

      {!fetchError && devices.length === 0 && (
        <div className="max-w-2xl mx-auto mt-16 text-center">
          <div className="text-4xl mb-4">📡</div>
          <h2 className="text-lg font-semibold text-white mb-2">Aucun capteur enregistré</h2>
          <p className="text-gray-400 text-sm mb-4">
            Enregistrez votre premier capteur via le formulaire ou via l&apos;API, puis démarrez la transmission MQTT.
          </p>
          <button
            onClick={openAddDevice}
            className="mb-6 px-4 py-2 rounded border border-gray-600 text-sm text-white hover:border-gray-400 transition-colors"
          >
            + Ajouter un capteur
          </button>
          <div className="text-left space-y-4">
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
                1 — Créer le capteur
              </p>
              <pre className="text-xs text-green-400 font-mono whitespace-pre-wrap break-all bg-gray-950 rounded p-3">
{`curl -s -X POST http://localhost:3000/api/devices \\
  -H "Content-Type: application/json" \\
  -d '{"name":"ESP32-CAM 001","mqttClientId":"esp32-cam-001","location":"Bureau"}' | jq .`}
              </pre>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
                2 — Simuler des données (sans hardware)
              </p>
              <pre className="text-xs text-blue-400 font-mono whitespace-pre-wrap break-all bg-gray-950 rounded p-3">
{`uv run --with paho-mqtt scripts/demo_mqtt.py`}
              </pre>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
                3 — Flasher sur ESP32 (hardware réel)
              </p>
              <pre className="text-xs text-yellow-400 font-mono whitespace-pre-wrap break-all bg-gray-950 rounded p-3">
{`# Configurer WiFi/MQTT dans config.h, puis :
pio run --target upload --environment zscore_demo`}
              </pre>
            </div>
          </div>
          <p className="text-xs text-gray-600 mt-6">
            La page se rafraîchit automatiquement dès qu&apos;un capteur est enregistré.
          </p>
        </div>
      )}

      {/* Forge view — model management pipeline */}
      {view === "forge" && <ForgeTab />}

      {/* Fleet view — devices + alert timeline */}
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

      {/* PTI view — worker map + alert timeline */}
      {view === "pti" && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2">
            <section className="mb-2">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">
                Carte travailleurs isolés
              </h2>
              <WorkerMap onSelectWorker={selectWorker} />
            </section>
          </div>
          <div>
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">
              Chronologie alertes
            </h2>
            <AlertTimeline />
          </div>
        </div>
      )}

      {/* Fatigue view — HR monitoring fleet + HRV detail chart */}
      {view === "fatigue" && devices.length > 0 && (
        <>
          <section className="mb-6">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">
              Surveillance fatigue — Ardent Pulse H2
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
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
          </section>
          {selectedId && <HRVChart deviceId={selectedId} />}
        </>
      )}

      {/* Thermique view — WBGT thermal stress fleet + temperature chart */}
      {view === "thermique" && devices.length > 0 && (
        <>
          <section className="mb-6">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">
              Surveillance thermique — Ardent Pulse H3
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
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
          </section>
          {selectedId && <TemperatureChart deviceId={selectedId} />}
        </>
      )}

      {/* Santé view — cross-module fleet health */}
      {view === "sante" && (
        <FleetHealth onSelectWorker={selectWorker} />
      )}

      {/* Worker view — individual multi-sensor detail */}
      {view === "worker" && selectedId && (
        <WorkerDetail deviceId={selectedId} onBack={() => setView("sante")} />
      )}

      {/* Detail view — single device */}
      {view === "detail" && devices.length > 0 && (
        <>
          <section className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">
                Capteurs actifs
              </h2>
              {selectedId && (() => {
                const sel = devices.find((d) => d.id === selectedId);
                return sel ? (
                  <button
                    onClick={() => openEditDevice(sel)}
                    className="text-xs text-gray-600 hover:text-gray-300 border border-gray-800 hover:border-gray-600 rounded px-2 py-1 transition-colors"
                  >
                    Modifier / Supprimer
                  </button>
                ) : null;
              })()}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {devices.map((d) => (
                <DeviceCard
                  key={d.id}
                  device={d}
                  selected={d.id === selectedId}
                  onClick={() => setSelectedId(d.id)}
                />
              ))}
            </div>
          </section>
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
      {/* Device create/edit modal */}
      {showDeviceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setShowDeviceModal(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
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
                <label className="block text-xs text-gray-400 mb-1">Client MQTT</label>
                <input
                  type="text"
                  value={deviceForm.mqttClientId}
                  onChange={(e) => setDeviceForm((f) => ({ ...f, mqttClientId: e.target.value }))}
                  placeholder="esp32-cam-001"
                  disabled={!!editingDeviceId}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500 disabled:opacity-40"
                />
                {editingDeviceId && <p className="text-[10px] text-gray-600 mt-0.5">Non modifiable après création</p>}
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

            {deviceFormError && (
              <p className="text-red-400 text-xs mt-3">{deviceFormError}</p>
            )}

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
                  onClick={async () => {
                    await handleDeleteDevice(editingDeviceId);
                    setShowDeviceModal(false);
                  }}
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
    </main>
  );
}
