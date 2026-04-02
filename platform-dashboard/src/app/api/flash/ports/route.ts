/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */

/**
 * GET /api/flash/ports — list available serial (COM) ports on Windows.
 */

import { exec } from "child_process";
import { promisify } from "util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execAsync = promisify(exec);

export async function GET() {
  try {
    // Query Win32 serial ports via PowerShell
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "Get-WmiObject Win32_SerialPort | Select-Object DeviceID,Description | ConvertTo-Json -Compress"`,
      { timeout: 5000 }
    );
    const raw = stdout.trim();
    if (!raw) return Response.json([]);

    // PowerShell returns an object (not array) when only one port found
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const ports = arr
      .filter((p: { DeviceID?: string }) => p.DeviceID)
      .map((p: { DeviceID: string; Description?: string }) => ({
        name:        p.DeviceID,
        description: p.Description ?? p.DeviceID,
      }));
    return Response.json(ports);
  } catch {
    // Fallback — return COM4 as default if WMI fails
    return Response.json([{ name: "COM4", description: "COM4 (default)" }]);
  }
}
