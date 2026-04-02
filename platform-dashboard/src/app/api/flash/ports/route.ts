/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */

/**
 * GET /api/flash/ports — list available serial (COM) ports on Windows.
 *
 * Strategy (most to least reliable):
 *  1. Get-PnpDevice  — catches USB hotplug immediately, friendly names
 *  2. Get-WmiObject  — fallback for older Windows / PowerShell 5
 *  3. SerialPort.GetPortNames() — last resort (no descriptions)
 */

import { exec } from "child_process";
import { promisify } from "util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execAsync = promisify(exec);

interface RawPort { name: string; description: string }

/** Parse PowerShell JSON output (object or array). */
function parsePS(stdout: string): RawPort[] {
  const raw = stdout.trim();
  if (!raw || raw === "null") return [];
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed : [parsed]) as RawPort[];
}

async function tryPnpDevice(): Promise<RawPort[]> {
  // Get-PnpDevice sees USB devices immediately on plug-in.
  // FriendlyName examples: "USB-SERIAL CH340 (COM4)", "Silicon Labs CP210x (COM3)"
  const script = `
    $r = Get-PnpDevice -PresentOnly -Class Ports -ErrorAction SilentlyContinue |
         Where-Object { $_.FriendlyName -match 'COM\\d+' } |
         ForEach-Object {
           $com = [regex]::Match($_.FriendlyName, 'COM\\d+').Value
           [PSCustomObject]@{ name = $com; description = $_.FriendlyName }
         }
    if ($r) { $r | ConvertTo-Json -Compress } else { '[]' }
  `.trim();
  const { stdout } = await execAsync(
    `powershell -NoProfile -Command "${script.replace(/"/g, '\\"').replace(/\n\s*/g, " ")}"`,
    { timeout: 4000 }
  );
  return parsePS(stdout);
}

async function tryWmi(): Promise<RawPort[]> {
  const { stdout } = await execAsync(
    `powershell -NoProfile -Command "Get-WmiObject Win32_SerialPort | Select-Object @{N='name';E={$_.DeviceID}},@{N='description';E={$_.Description}} | ConvertTo-Json -Compress"`,
    { timeout: 4000 }
  );
  return parsePS(stdout).filter((p) => p.name);
}

async function tryDotNet(): Promise<RawPort[]> {
  const { stdout } = await execAsync(
    `powershell -NoProfile -Command "[System.IO.Ports.SerialPort]::GetPortNames() | ConvertTo-Json -Compress"`,
    { timeout: 3000 }
  );
  const raw = stdout.trim();
  if (!raw || raw === "null") return [];
  const names: string[] = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [JSON.parse(raw)];
  return names.map((n) => ({ name: n, description: n }));
}

export async function GET() {
  // Try strategies in order
  for (const strategy of [tryPnpDevice, tryWmi, tryDotNet]) {
    try {
      const ports = await strategy();
      if (ports.length > 0) return Response.json(ports);
    } catch {
      // continue to next strategy
    }
  }
  return Response.json([]);
}
