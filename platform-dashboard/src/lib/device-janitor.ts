/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */

/**
 * Device Janitor — automatic stale device management.
 *
 * Two configurable thresholds (env vars, in days):
 *   DEVICE_INACTIVE_DAYS  (default: 7)  — mark active=false if no reading received
 *   DEVICE_PURGE_DAYS     (default: 30) — delete if inactive AND zero total readings
 *
 * Runs once at server startup, then every hour.
 * Can also be triggered manually via POST /api/devices/janitor.
 */

import { prisma } from "@/lib/prisma";

const INACTIVE_DAYS = parseInt(process.env.DEVICE_INACTIVE_DAYS ?? "7",  10);
const PURGE_DAYS    = parseInt(process.env.DEVICE_PURGE_DAYS    ?? "30", 10);

export interface JanitorResult {
  deactivated: number;
  purged:      number;
  checkedAt:   string;
}

export async function runJanitor(): Promise<JanitorResult> {
  const now          = new Date();
  const inactiveCutoff = new Date(now.getTime() - INACTIVE_DAYS * 86_400_000);
  const purgeCutoff    = new Date(now.getTime() - PURGE_DAYS    * 86_400_000);

  // 1. Deactivate devices with no reading since INACTIVE_DAYS
  //    (only those currently marked active)
  const toDeactivate = await prisma.device.findMany({
    where: {
      active: true,
      readings: { none: { timestamp: { gte: inactiveCutoff } } },
    },
    select: { id: true, name: true, mqttClientId: true, createdAt: true },
  });

  // Don't deactivate brand-new devices that just haven't received data yet
  const staleToDeactivate = toDeactivate.filter(
    (d) => d.createdAt < inactiveCutoff
  );

  let deactivated = 0;
  if (staleToDeactivate.length > 0) {
    const result = await prisma.device.updateMany({
      where: { id: { in: staleToDeactivate.map((d) => d.id) } },
      data:  { active: false },
    });
    deactivated = result.count;
    console.log(`[janitor] Deactivated ${deactivated} stale device(s):`,
      staleToDeactivate.map((d) => d.mqttClientId).join(", "));
  }

  // 2. Purge devices inactive for PURGE_DAYS AND with zero readings
  const toPurge = await prisma.device.findMany({
    where: {
      active:   false,
      updatedAt: { lt: purgeCutoff },
      readings:  { none: {} },
    },
    select: { id: true, mqttClientId: true },
  });

  let purged = 0;
  if (toPurge.length > 0) {
    await prisma.device.deleteMany({
      where: { id: { in: toPurge.map((d) => d.id) } },
    });
    purged = toPurge.length;
    console.log(`[janitor] Purged ${purged} empty device(s):`,
      toPurge.map((d) => d.mqttClientId).join(", "));
  }

  return { deactivated, purged, checkedAt: now.toISOString() };
}

// ── Background scheduler ──────────────────────────────────────────────────────

let started = false;

export function startJanitorScheduler() {
  if (started) return;
  started = true;

  // Run once at startup (after a short delay to let DB settle)
  setTimeout(() => { void runJanitor(); }, 10_000);

  // Then every hour
  setInterval(() => { void runJanitor(); }, 60 * 60 * 1000);
}
