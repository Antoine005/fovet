/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */

/**
 * GET /api/flash/ports — list available serial (COM) ports on Windows.
 *
 * Strategy:
 *  1. Get-PnpDevice -Class Ports (includes USB-SERIAL CH340 etc.)
 *  2. [System.IO.Ports.SerialPort]::GetPortNames()  (fast, no descriptions)
 *
 * Win32_SerialPort intentionally avoided — it only returns ACPI COM ports,
 * not USB-UART bridges (CH340, CP2102, FTDI), which are the ones we care about.
 */

import { exec } from "child_process";
import { promisify } from "util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execAsync = promisify(exec);

export async function GET() {
  // Strategy 1 — Get-PnpDevice (sees USB-SERIAL CH340, CP2102, FTDI, etc.)
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "` +
      `$r = Get-PnpDevice -Class Ports -ErrorAction Stop | ` +
      `Where-Object { $_.Status -eq 'OK' } | ` +
      `Select-Object @{N='name';E={if ($_.FriendlyName -match '(COM[0-9]+)') { $matches[1] }}},@{N='description';E={$_.FriendlyName}} | ` +
      `Where-Object { $_.name }; ` +
      `if ($r) { $r | ConvertTo-Json -Compress } else { '[]' }"`,
      { timeout: 4000 }
    );
    const raw = stdout.trim();
    if (raw && raw !== "null") {
      const parsed = JSON.parse(raw);
      const arr: { name: string; description: string }[] = Array.isArray(parsed) ? parsed : [parsed];
      const ports = arr.filter((p) => p.name);
      if (ports.length > 0) return Response.json(ports);
    }
  } catch { /* fall through */ }

  // Strategy 2 — .NET SerialPort.GetPortNames() (no descriptions)
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "[System.IO.Ports.SerialPort]::GetPortNames() | ConvertTo-Json -Compress"`,
      { timeout: 2000 }
    );
    const raw = stdout.trim();
    if (raw && raw !== "null") {
      const parsed = JSON.parse(raw);
      const names: string[] = Array.isArray(parsed) ? parsed : [parsed];
      const ports = names.filter(Boolean).map((n) => ({ name: n, description: n }));
      if (ports.length > 0) return Response.json(ports);
    }
  } catch { /* fall through */ }

  return Response.json([]);
}
