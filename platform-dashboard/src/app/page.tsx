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

interface Device {
  id: string;
  name: string;
  mqttClientId: string;
  location: string | null;
  active: boolean;
}

export default function DashboardPage() {
  const router = useRouter();
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [view, setView] = useState<"fleet" | "detail" | "pti" | "fatigue" | "thermique">("fleet");

  useEffect(() => {
    apiFetch("/api/devices")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Device[]) => {
        setDevices(data);
        if (data.length > 0) setSelectedId(data[0].id);
        // Switch directly to detail view if only one device
        if (data.length === 1) setView("detail");
      })
      .catch((err: unknown) => {
        setFetchError(err instanceof Error ? err.message : "Erreur réseau");
      });
  }, [router]);

  const selectDevice = (id: string) => {
    setSelectedId(id);
    setView("detail");
  };

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Fovet Vigie
          </h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Supervision temps réel — Fovet Sentinelle
          </p>
        </div>
        <div className="flex items-center gap-3">
          {devices.length > 0 && (
            <div className="flex rounded-lg border border-gray-800 overflow-hidden text-xs">
              <button
                onClick={() => setView("fleet")}
                className={`px-3 py-1.5 transition-colors ${
                  view === "fleet"
                    ? "bg-gray-800 text-white"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                Flotte
              </button>
              <button
                onClick={() => setView("detail")}
                className={`px-3 py-1.5 transition-colors ${
                  view === "detail"
                    ? "bg-gray-800 text-white"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                Détail
              </button>
              <button
                onClick={() => setView("pti")}
                className={`px-3 py-1.5 transition-colors ${
                  view === "pti"
                    ? "bg-gray-800 text-white"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                PTI
              </button>
              <button
                onClick={() => setView("fatigue")}
                className={`px-3 py-1.5 transition-colors ${
                  view === "fatigue"
                    ? "bg-gray-800 text-white"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                Fatigue
              </button>
              <button
                onClick={() => setView("thermique")}
                className={`px-3 py-1.5 transition-colors ${
                  view === "thermique"
                    ? "bg-gray-800 text-white"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                Thermique
              </button>
            </div>
          )}
          <span className="text-xs text-gray-500 font-mono">
            {new Date().toLocaleString("fr-FR")}
          </span>
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
        <p className="text-gray-500 text-sm">
          Aucun capteur enregistré.{" "}
          <code className="text-blue-400">POST /api/devices</code> pour en ajouter un.
        </p>
      )}

      {/* Fleet view — all devices simultaneously */}
      {view === "fleet" && devices.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {devices.map((d) => (
            <FleetPanel
              key={d.id}
              deviceId={d.id}
              deviceName={d.name}
              mqttClientId={d.mqttClientId}
              location={d.location}
              onSelect={() => selectDevice(d.id)}
            />
          ))}
        </div>
      )}

      {/* PTI view — worker fleet status + alert timeline */}
      {view === "pti" && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2">
            <section className="mb-2">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">
                Carte travailleurs isolés
              </h2>
              <WorkerMap
                onSelectWorker={(id) => {
                  setSelectedId(id);
                  setView("detail");
                }}
              />
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
              Surveillance fatigue — Sentinelle H2.3
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

          {selectedId && (
            <HRVChart deviceId={selectedId} />
          )}
        </>
      )}

      {/* Thermique view — WBGT thermal stress fleet + temperature chart */}
      {view === "thermique" && devices.length > 0 && (
        <>
          <section className="mb-6">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">
              Surveillance thermique — Sentinelle H3.3
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

          {selectedId && (
            <TemperatureChart deviceId={selectedId} />
          )}
        </>
      )}

      {/* Detail view — single device */}
      {view === "detail" && devices.length > 0 && (
        <>
          <section className="mb-6">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">
              Capteurs actifs
            </h2>
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
    </main>
  );
}
