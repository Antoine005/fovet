"use client";

const CONNECTED_THRESHOLD_MS = 30_000; // 30 s

interface Device {
  id: string;
  name: string;
  mqttClientId: string;
  location: string | null;
  active: boolean;
  lastReadingAt: string | null;
}

interface Props {
  device: Device;
  selected: boolean;
  onClick: () => void;
}

export function DeviceCard({ device, selected, onClick }: Props) {
  const isConnected =
    device.lastReadingAt !== null &&
    Date.now() - new Date(device.lastReadingAt).getTime() < CONNECTED_THRESHOLD_MS;

  const dotColor = device.lastReadingAt === null
    ? "bg-gray-600"          // never received data
    : isConnected
      ? "bg-green-400"       // data within last 30 s
      : "bg-red-500";        // stale

  const dotTitle = device.lastReadingAt === null
    ? "Aucune donnée reçue"
    : isConnected
      ? "Connecté"
      : "Déconnecté";

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl border p-4 transition-colors cursor-pointer ${
        selected
          ? "border-blue-500 bg-blue-500/10"
          : "border-gray-800 bg-gray-900 hover:border-gray-600"
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium text-sm text-white">{device.name}</span>
        <span className={`w-2 h-2 rounded-full ${dotColor}`} title={dotTitle} />
      </div>
      <p className="text-xs text-gray-500 font-mono">{device.mqttClientId}</p>
      {device.location && (
        <p className="text-xs text-gray-600 mt-1">{device.location}</p>
      )}
      <p className={`text-xs mt-1 ${isConnected ? "text-green-500" : "text-red-500"}`}>
        {device.lastReadingAt === null
          ? "Aucune donnée"
          : isConnected
            ? "Connecté"
            : "Déconnecté"}
      </p>
    </button>
  );
}
