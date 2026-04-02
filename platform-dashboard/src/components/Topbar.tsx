/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */
"use client";

import React from "react";

interface TopbarProps {
  clock:        string;
  onAddDevice:  () => void;
  onJanitor:    () => void;
  onLogout:     () => void;
  janitorResult: { deactivated: number; purged: number } | null;
}

export function Topbar({ clock, onAddDevice, onJanitor, onLogout, janitorResult }: TopbarProps) {
  return (
    <header className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-gray-800 bg-gray-950">
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-bold tracking-tight text-white">Ardent Watch</h1>
        <span className="hidden sm:block text-xs text-gray-700">Supervision temps réel</span>

        {/* Janitor result toast */}
        {janitorResult && (
          <span className="text-xs text-gray-400 bg-gray-800 px-2.5 py-1 rounded-full border border-gray-700">
            {janitorResult.deactivated > 0 || janitorResult.purged > 0
              ? `${janitorResult.deactivated} désactivé(s) · ${janitorResult.purged} supprimé(s)`
              : "Aucun capteur à nettoyer"}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-gray-600 tabular-nums hidden md:block">{clock}</span>

        <button
          onClick={onAddDevice}
          className="text-xs px-2.5 py-1.5 rounded border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-colors"
        >
          + Capteur
        </button>

        <button
          onClick={onJanitor}
          title="Désactive les capteurs sans données depuis 7j, supprime ceux vides depuis 30j"
          className="text-xs px-2.5 py-1.5 rounded border border-gray-800 text-gray-600 hover:text-gray-400 hover:border-gray-600 transition-colors"
        >
          Nettoyer
        </button>

        <div className="w-px h-4 bg-gray-800" />

        <button
          onClick={onLogout}
          className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
        >
          Déconnexion
        </button>
      </div>
    </header>
  );
}
