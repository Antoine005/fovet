"use client";

interface Device {
  id: string;
  name: string;
  mqttClientId: string;
  location: string | null;
  active: boolean;
}

interface Props {
  device: Device;
  selected: boolean;
  onClick: () => void;
}

export function DeviceCard({ device, selected, onClick }: Props) {
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
        <span className="w-2 h-2 rounded-full bg-green-400" title="Actif" />
      </div>
      <p className="text-xs text-gray-500 font-mono">{device.mqttClientId}</p>
      {device.location && (
        <p className="text-xs text-gray-600 mt-1">{device.location}</p>
      )}
    </button>
  );
}
