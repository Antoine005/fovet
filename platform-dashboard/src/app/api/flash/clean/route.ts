/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent-ai.fr
 */

/**
 * POST /api/flash/clean — delete compiled PlatformIO artefacts for an environment.
 *
 * Removes .pio/build/<env> so the next flash is a clean full recompilation.
 * The operation is synchronous and fast (just an rmdir).
 *
 * Body: { env: string, project: string }
 *   env     — PlatformIO environment name (e.g. "person_detection")
 *   project — example directory name under edge-core/examples/esp32/
 *
 * Returns: { ok: true, deleted: "<absolute path>" }
 *          { ok: false, reason: "not_found" } if nothing to delete
 */

import path from "path";
import fs   from "fs";

export const runtime = "nodejs";

const REPO_ROOT = path.resolve(process.cwd(), "..");

export async function POST(request: Request) {
  let body: { env?: string; project?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { env, project } = body;
  if (!env || !project) {
    return Response.json({ error: "env and project are required" }, { status: 400 });
  }

  // Guard against path traversal
  if (env.includes("..") || project.includes("..") || env.includes("/") || project.includes("/")) {
    return Response.json({ error: "Invalid env or project" }, { status: 400 });
  }

  const buildDir = path.join(
    REPO_ROOT, "edge-core", "examples", "esp32", project, ".pio", "build", env
  );

  if (!fs.existsSync(buildDir)) {
    return Response.json({ ok: false, reason: "not_found", path: buildDir });
  }

  try {
    fs.rmSync(buildDir, { recursive: true, force: true });
    return Response.json({ ok: true, deleted: buildDir });
  } catch (err) {
    return Response.json({ error: `Failed to delete: ${err}` }, { status: 500 });
  }
}
