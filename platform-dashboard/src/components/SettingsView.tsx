/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent-ai.fr
 */
"use client";

/**
 * SettingsView — G9
 * Affiche la configuration courante (MQTT, DB) en lecture seule et
 * permet d'éditer les seuils d'alerte, le janitor et le webhook.
 */

import React, { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

interface Settings {
  zscore_default_threshold:  number;
  min_samples_default:       number;
  device_inactive_days:      number;
  device_purge_days:         number;
  alert_webhook_url:         string;
  alert_webhook_min_level:   string;
  _readonly: {
    mqtt_broker_url: string;
    mqtt_username:   string;
    database_url:    string;
  };
}

function Field({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="py-2.5 border-b border-gray-800/60 last:border-b-0">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[10px] text-gray-500 shrink-0">{label}</span>
        <span className="font-mono text-[11px] text-gray-300 text-right break-all">{value}</span>
      </div>
      {hint && <p className="text-[9px] text-gray-600 mt-0.5">{hint}</p>}
    </div>
  );
}

export default function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  // Editable local copies
  const [threshold,     setThreshold]     = useState(3.0);
  const [minSamples,    setMinSamples]    = useState(30);
  const [inactiveDays,  setInactiveDays]  = useState(7);
  const [purgeDays,     setPurgeDays]     = useState(30);
  const [webhookUrl,    setWebhookUrl]    = useState("");
  const [webhookLevel,  setWebhookLevel]  = useState("DANGER");

  useEffect(() => {
    apiFetch("/api/settings").then(async (r) => {
      if (!r.ok) return;
      const s = await r.json() as Settings;
      setSettings(s);
      setThreshold(s.zscore_default_threshold);
      setMinSamples(s.min_samples_default);
      setInactiveDays(s.device_inactive_days);
      setPurgeDays(s.device_purge_days);
      setWebhookUrl(s.alert_webhook_url);
      setWebhookLevel(s.alert_webhook_min_level);
    });
  }, []);

  const handleSave = async () => {
    setSaving(true); setSaved(false); setError(null);
    try {
      const res = await apiFetch("/api/settings", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zscore_default_threshold: threshold,
          min_samples_default:      minSamples,
          device_inactive_days:     inactiveDays,
          device_purge_days:        purgeDays,
          alert_webhook_url:        webhookUrl,
          alert_webhook_min_level:  webhookLevel,
        }),
      });
      if (res.ok) {
        setSettings(await res.json() as Settings);
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      } else {
        setError("Erreur lors de la sauvegarde");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-32 text-xs text-gray-600">
        Chargement…
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 py-2">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Paramètres</h2>

      {/* ── Infrastructure (read-only) ─────────────────────────────────── */}
      <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-3">
          Infrastructure — lecture seule
        </h3>
        <p className="text-[9px] text-gray-600 mb-3">
          Ces paramètres sont définis dans le fichier <code className="font-mono">.env</code> et nécessitent un redémarrage du serveur pour être modifiés.
        </p>
        <Field label="Broker MQTT"     value={settings._readonly.mqtt_broker_url} />
        <Field label="Utilisateur MQTT" value={settings._readonly.mqtt_username || "(anonyme)"} />
        <Field label="Base de données" value={settings._readonly.database_url}
               hint="Mot de passe masqué" />
      </section>

      {/* ── Détection (editable) ───────────────────────────────────────── */}
      <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-3">
          Seuils de détection par défaut
        </h3>
        <p className="text-[9px] text-gray-600 mb-3">
          Utilisés par Forge Studio lors de la génération de la config YAML.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-[9px] text-gray-500 uppercase tracking-wider block mb-1">
              Seuil Z-Score (σ)
            </label>
            <input
              type="number" value={threshold} min={0.5} max={10} step={0.1}
              onChange={(e) => setThreshold(parseFloat(e.target.value) || 3)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500"
            />
            <p className="text-[9px] text-gray-600 mt-1">3σ ≈ 0.3% faux positifs sur gaussienne</p>
          </div>
          <div>
            <label className="text-[9px] text-gray-500 uppercase tracking-wider block mb-1">
              Min samples (warm-up)
            </label>
            <input
              type="number" value={minSamples} min={1} max={500}
              onChange={(e) => setMinSamples(parseInt(e.target.value, 10) || 30)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500"
            />
            <p className="text-[9px] text-gray-600 mt-1">Samples avant activation du seuil</p>
          </div>
        </div>
      </section>

      {/* ── Janitor (editable) ─────────────────────────────────────────── */}
      <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-3">
          Nettoyage automatique (Device Janitor)
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-[9px] text-gray-500 uppercase tracking-wider block mb-1">
              Inactif après (jours)
            </label>
            <input
              type="number" value={inactiveDays} min={1} max={365}
              onChange={(e) => setInactiveDays(parseInt(e.target.value, 10) || 7)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500"
            />
            <p className="text-[9px] text-gray-600 mt-1">Marqué inactif si aucune lecture</p>
          </div>
          <div>
            <label className="text-[9px] text-gray-500 uppercase tracking-wider block mb-1">
              Supprimé après (jours)
            </label>
            <input
              type="number" value={purgeDays} min={1} max={3650}
              onChange={(e) => setPurgeDays(parseInt(e.target.value, 10) || 30)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500"
            />
            <p className="text-[9px] text-gray-600 mt-1">Supprimé si inactif et sans lectures</p>
          </div>
        </div>
      </section>

      {/* ── Webhook (editable) ─────────────────────────────────────────── */}
      <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-3">
          Webhook alertes
        </h3>
        <div className="space-y-3">
          <div>
            <label className="text-[9px] text-gray-500 uppercase tracking-wider block mb-1">URL POST</label>
            <input
              type="url" value={webhookUrl} placeholder="https://hooks.slack.com/…"
              onChange={(e) => setWebhookUrl(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 placeholder-gray-600 outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-[9px] text-gray-500 uppercase tracking-wider block mb-1">Niveau minimum</label>
            <select value={webhookLevel} onChange={(e) => setWebhookLevel(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2.5 py-1.5 text-[11px] text-gray-100 outline-none focus:border-blue-500">
              <option value="ALL">Toutes les alertes</option>
              <option value="DANGER">DANGER + CRITICAL</option>
              <option value="CRITICAL">CRITICAL uniquement</option>
            </select>
          </div>
        </div>
      </section>

      {/* ── Save ───────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-end gap-3">
        {error && <span className="text-[10px] text-red-400">{error}</span>}
        {saved  && <span className="text-[10px] text-green-400">✓ Paramètres sauvegardés</span>}
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded bg-red-600 hover:bg-red-500 disabled:opacity-50 text-xs text-white font-semibold transition-colors"
        >
          {saving ? "Sauvegarde…" : "Enregistrer"}
        </button>
      </div>
    </div>
  );
}
