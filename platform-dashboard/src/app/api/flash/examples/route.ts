/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent-ai.fr
 */

/**
 * GET /api/flash/examples — list flashable examples discovered from edge-core.
 *
 * Scans edge-core/examples/esp32/ for subdirectories that contain both
 * platformio.ini and flash.manifest.json. Returns the manifest array.
 * No code change needed to add a new example — just add flash.manifest.json.
 */

import path from "path";
import fs   from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXAMPLES_DIR = path.resolve(process.cwd(), "..", "edge-core", "examples", "esp32");

interface FlashManifest {
  id:              string;
  label:           string;
  env:             string;
  description:     string;
  requiredSensors: string[];
  warnIfMissing:   string[];
}

export async function GET() {
  const examples: FlashManifest[] = [];

  try {
    const entries = fs.readdirSync(EXAMPLES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir          = path.join(EXAMPLES_DIR, entry.name);
      const manifestPath = path.join(dir, "flash.manifest.json");
      const pioPath      = path.join(dir, "platformio.ini");
      if (!fs.existsSync(manifestPath) || !fs.existsSync(pioPath)) continue;
      try {
        const raw = fs.readFileSync(manifestPath, "utf-8");
        const manifest = JSON.parse(raw) as FlashManifest;
        if (manifest.id && manifest.label && manifest.env) {
          examples.push(manifest);
        }
      } catch { /* malformed manifest — skip */ }
    }
  } catch { /* EXAMPLES_DIR missing */ }

  // Sort: no required sensors first, then by label
  examples.sort((a, b) => {
    const aReq = a.requiredSensors.length;
    const bReq = b.requiredSensors.length;
    if (aReq !== bReq) return aReq - bReq;
    return a.label.localeCompare(b.label);
  });

  return Response.json(examples);
}
