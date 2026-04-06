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
 *  1. Get-CimInstance Win32_SerialPort  (~450ms, descriptions)
 *  2. [System.IO.Ports.SerialPort]::GetPortNames()  (fast, no descriptions)
 */

import { exec } from "child_process";
import { promisify } from "util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execAsync = promisify(exec);

export async function GET() {
  // Strategy 1 — Get-CimInstance (modern WMI, fast, includes description)
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "` +
      `$r = Get-CimInstance Win32_SerialPort -ErrorAction Stop | ` +
      `Select-Object @{N='name';E={$_.DeviceID}},@{N='description';E={$_.Description}}; ` +
      `if ($r) { $r | ConvertTo-Json -Compress } else { '[]' }"`,
      { timeout: 3000 }
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
