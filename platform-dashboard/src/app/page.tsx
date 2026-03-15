"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { ReadingChart } from "@/components/ReadingChart";
import { AlertList } from "@/components/AlertList";
import { DeviceCard } from "@/components/DeviceCard";
import { FleetPanel } from "@/components/FleetPanel";
import FleetHealth from "@/components/FleetHealth";

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
  const [view, setView] = useState<"fleet" | "detail" | "sante">("fleet");

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
                onClick={() => setView("sante")}
                className={`px-3 py-1.5 transition-colors ${
                  view === "sante"
                    ? "bg-gray-800 text-white"
                    : "text-gray-500 hover:text-gray-300"
                }`}
              >
                Santé
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


      {/* Santé view — cross-module fleet health */}
      {view === "sante" && (
        <FleetHealth />
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
