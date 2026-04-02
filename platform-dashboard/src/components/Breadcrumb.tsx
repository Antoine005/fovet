/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */
"use client";

import React, { Fragment } from "react";
import type { ViewType } from "@/components/Sidebar";

interface BreadcrumbDevice {
  name:     string;
  location: string | null;
}

interface BreadcrumbProps {
  view:           ViewType;
  selectedDevice: BreadcrumbDevice | null;
}

const VIEW_LABEL: Record<ViewType, string> = {
  fleet:     "Flotte",
  detail:    "Détail",
  pti:       "PTI — Travailleurs isolés",
  fatigue:   "Fatigue — H2",
  thermique: "Thermique — H3",
  sante:     "Santé flotte",
  worker:    "Détail travailleur",
  forge:     "Ardent Forge",
  flash:     "Flash ESP32",
};

function buildSegments(view: ViewType, device: BreadcrumbDevice | null): string[] {
  const base = VIEW_LABEL[view];
  switch (view) {
    case "detail":
      return device ? ["Flotte", base, device.name] : ["Flotte", base];
    case "worker":
      return device ? ["Santé", base, device.name] : ["Santé", base];
    case "fatigue":
    case "thermique":
      return device ? [base, device.name] : [base];
    case "pti":
    case "sante":
    case "fleet":
    case "forge":
    case "flash":
    default:
      return [base];
  }
}

export function Breadcrumb({ view, selectedDevice }: BreadcrumbProps) {
  const segments = buildSegments(view, selectedDevice);

  return (
    <nav className="h-9 shrink-0 flex items-center px-4 border-b border-gray-800/60 bg-gray-950/80">
      {segments.map((seg, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <svg className="mx-1.5 w-3 h-3 text-gray-700 shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 2l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <span
            className={`text-xs truncate ${
              i === segments.length - 1 ? "text-gray-300 font-medium" : "text-gray-600"
            }`}
          >
            {seg}
          </span>
        </Fragment>
      ))}
    </nav>
  );
}
