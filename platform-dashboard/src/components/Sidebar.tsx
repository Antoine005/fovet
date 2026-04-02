/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */
"use client";

import React, { useState } from "react";

// ── View type ─────────────────────────────────────────────────────────────────

export type ViewType =
  | "fleet" | "detail" | "pti" | "fatigue"
  | "thermique" | "sante" | "worker" | "forge" | "flash";

// ── SVG icons (20×20, stroke-based) ──────────────────────────────────────────

function IconGrid() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
      <rect x="2" y="2" width="6" height="6" rx="1" />
      <rect x="12" y="2" width="6" height="6" rx="1" />
      <rect x="2" y="12" width="6" height="6" rx="1" />
      <rect x="12" y="12" width="6" height="6" rx="1" />
    </svg>
  );
}
function IconBars() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
      <rect x="2" y="12" width="3" height="6" rx="0.5" />
      <rect x="7" y="8"  width="3" height="10" rx="0.5" />
      <rect x="12" y="4" width="3" height="14" rx="0.5" />
      <rect x="17" y="1" width="1.5" height="17" rx="0.5" />
    </svg>
  );
}
function IconShield() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
      <path d="M10 2L3 5v5c0 4 3.5 7 7 8 3.5-1 7-4 7-8V5l-7-3z" strokeLinejoin="round" />
      <path d="M7 10l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconHeart() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
      <path d="M10 17s-7-4.5-7-9a4 4 0 018 0 4 4 0 018 0c0 4.5-7 9-7 9z" strokeLinejoin="round" />
    </svg>
  );
}
function IconThermo() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
      <path d="M10 2v9.27" strokeLinecap="round" />
      <circle cx="10" cy="14" r="3" />
      <path d="M7 7h1M7 5h1M7 9h1" strokeLinecap="round" />
    </svg>
  );
}
function IconActivity() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
      <polyline points="2,10 5,10 7,4 10,16 13,7 15,10 18,10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconGear() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
      <circle cx="10" cy="10" r="3" />
      <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42" strokeLinecap="round" />
    </svg>
  );
}
function IconBolt() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
      <polyline points="12,2 7,11 11,11 8,18 13,9 9,9 12,2" strokeLinejoin="round" />
    </svg>
  );
}

// ── Nav items definition ───────────────────────────────────────────────────────

interface NavItem {
  view:      ViewType;
  label:     string;
  icon:      React.ReactNode;
  devicesRequired: boolean; // only show when devices exist
}

const NAV_ITEMS: NavItem[] = [
  { view: "fleet",     label: "Flotte",     icon: <IconGrid />,     devicesRequired: true  },
  { view: "detail",    label: "Détail",     icon: <IconBars />,     devicesRequired: true  },
  { view: "pti",       label: "PTI",        icon: <IconShield />,   devicesRequired: false },
  { view: "fatigue",   label: "Fatigue",    icon: <IconHeart />,    devicesRequired: true  },
  { view: "thermique", label: "Thermique",  icon: <IconThermo />,   devicesRequired: true  },
  { view: "sante",     label: "Santé",      icon: <IconActivity />, devicesRequired: true  },
];

const TOOL_ITEMS: NavItem[] = [
  { view: "forge", label: "Forge", icon: <IconGear />,  devicesRequired: false },
  { view: "flash", label: "Flash", icon: <IconBolt />,  devicesRequired: false },
];

// ── Component ─────────────────────────────────────────────────────────────────

interface SidebarProps {
  view:          ViewType;
  onViewChange:  (v: ViewType) => void;
  hasDevices:    boolean;
}

export function Sidebar({ view, onViewChange, hasDevices }: SidebarProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <nav
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      className={`relative flex flex-col shrink-0 h-screen bg-gray-900 border-r border-gray-800 transition-all duration-200 z-40 ${
        expanded ? "w-44" : "w-14"
      }`}
    >
      {/* Logo */}
      <div className="h-12 flex items-center px-3.5 border-b border-gray-800 shrink-0">
        <div className="w-7 h-7 rounded-lg bg-red-600 flex items-center justify-center shrink-0">
          <span className="text-white text-xs font-bold tracking-tight">A</span>
        </div>
        {expanded && (
          <span className="ml-2.5 text-sm font-bold text-white whitespace-nowrap overflow-hidden">
            Ardent
          </span>
        )}
      </div>

      {/* Main nav */}
      <div className="flex flex-col gap-0.5 px-1.5 pt-3 flex-1">
        {NAV_ITEMS.filter((item) => !item.devicesRequired || hasDevices).map((item) => (
          <NavButton
            key={item.view}
            item={item}
            active={view === item.view}
            expanded={expanded}
            onClick={() => onViewChange(item.view)}
          />
        ))}
      </div>

      {/* Tools separator + tool items */}
      <div className="px-1.5 pb-3">
        <div className="border-t border-gray-800 my-2 mx-1" />
        {TOOL_ITEMS.map((item) => (
          <NavButton
            key={item.view}
            item={item}
            active={view === item.view}
            expanded={expanded}
            onClick={() => onViewChange(item.view)}
          />
        ))}
      </div>
    </nav>
  );
}

// ── NavButton sub-component ───────────────────────────────────────────────────

function NavButton({
  item, active, expanded, onClick,
}: {
  item: NavItem;
  active: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <div className="relative group">
      <button
        onClick={onClick}
        className={`flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg transition-colors text-left ${
          active
            ? "bg-gray-800 text-white"
            : "text-gray-500 hover:text-gray-200 hover:bg-gray-800/60"
        }`}
      >
        <span className="shrink-0">{item.icon}</span>
        {expanded && (
          <span className="text-xs font-medium whitespace-nowrap overflow-hidden">
            {item.label}
          </span>
        )}
        {active && !expanded && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-red-500 rounded-r-full" />
        )}
      </button>
      {/* Tooltip — only visible when collapsed */}
      {!expanded && (
        <div className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2.5 px-2 py-1 bg-gray-800 border border-gray-700 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg">
          {item.label}
        </div>
      )}
    </div>
  );
}
