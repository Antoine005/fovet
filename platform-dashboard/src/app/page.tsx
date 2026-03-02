"use client";

import { useEffect, useState } from "react";
import { ReadingChart } from "@/components/ReadingChart";
import { AlertList } from "@/components/AlertList";
import { DeviceCard } from "@/components/DeviceCard";

interface Device {
  id: string;
  name: string;
  mqttClientId: string;
  location: string | null;
  active: boolean;
}

export default function DashboardPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/devices")
      .then((r) => r.json())
      .then((data: Device[]) => {
        setDevices(data);
        if (data.length > 0) setSelectedId(data[0].id);
      })
      .catch(console.error);
  }, []);

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
        <span className="text-xs text-gray-500 font-mono">
          {new Date().toLocaleString("fr-FR")}
        </span>
      </header>

      <section className="mb-6">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">
          Capteurs actifs
        </h2>
        {devices.length === 0 ? (
          <p className="text-gray-500 text-sm">
            Aucun capteur enregistré.{" "}
            <code className="text-blue-400">POST /api/devices</code> pour en ajouter un.
          </p>
        ) : (
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
        )}
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
    </main>
  );
}
