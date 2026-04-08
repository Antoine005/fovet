/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent-ai.fr
 */

/**
 * POST /api/flash/start — launch a PlatformIO upload job.
 *
 * Body: { env: string, project: string, port?: string }
 *   env     — PlatformIO environment name (e.g. "esp32cam")
 *   project — path to the PlatformIO project dir (relative to edge-core/examples/esp32/)
 *   port    — serial port override (e.g. "COM4")
 *
 * Returns: { jobId: string }
 */

import { spawn, execSync } from "child_process";
import { randomUUID }      from "crypto";
import path                from "path";
import fs                  from "fs";
import { flashJobs }       from "@/lib/flash-jobs";

export const runtime = "nodejs";

/** Find the pio executable — env override, PATH lookup, then known install locations. */
function findPio(): string {
  if (process.env.PIO_PATH && fs.existsSync(process.env.PIO_PATH)) {
    return process.env.PIO_PATH;
  }
  try {
    // Works if pio is in PATH
    const found = execSync("where pio", { timeout: 2000 }).toString().split("\n")[0].trim();
    if (found && fs.existsSync(found)) return found;
  } catch { /* not in PATH */ }
  // Common install paths (Python version-agnostic)
  const localApp = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    path.join(localApp, "Programs", "Python", "Python313", "Scripts", "pio.exe"),
    path.join(localApp, "Programs", "Python", "Python312", "Scripts", "pio.exe"),
    path.join(localApp, "Programs", "Python", "Python311", "Scripts", "pio.exe"),
    path.join(process.env.USERPROFILE ?? "", ".platformio", "penv", "Scripts", "pio.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "pio"; // last resort — let the OS resolve it
}

const PIO_EXE = findPio();

// Root of the monorepo (platform-dashboard is one level deep from root)
const REPO_ROOT = path.resolve(process.cwd(), "..");

export async function POST(request: Request) {
  let body: { env?: string; project?: string; port?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { env, project, port } = body;
  if (!env || !project) {
    return Response.json({ error: "env and project are required" }, { status: 400 });
  }

  // Resolve project directory
  const projectDir = path.join(REPO_ROOT, "edge-core", "examples", "esp32", project);

  const jobId = randomUUID();
  flashJobs.cleanup();
  const job = flashJobs.create(jobId, env, project);

  // Build pio args
  const args = ["run", "--target", "upload", "--environment", env];
  if (port) args.push("--upload-port", port);

  job.lines.push(`[ardent] Lancement : pio ${args.join(" ")}\n`);
  job.lines.push(`[ardent] Projet    : ${projectDir}\n`);
  job.lines.push(`[ardent] Port      : ${port ?? "platformio.ini"}\n\n`);

  // Spawn pio — fire and forget
  try {
    const proc = spawn(PIO_EXE, args, {
      cwd: projectDir,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    proc.stdout.on("data", (d: Buffer) => job.lines.push(d.toString("utf8")));
    proc.stderr.on("data", (d: Buffer) => job.lines.push(d.toString("utf8")));
    proc.on("error", (err: Error) => {
      job.lines.push(`\n[ardent] Erreur lancement : ${err.message}\n`);
      job.done     = true;
      job.exitCode = -1;
    });
    proc.on("close", (code: number | null) => {
      job.done     = true;
      job.exitCode = code;
      job.lines.push(
        code === 0
          ? "\n[ardent] Flash terminé avec succès ✓\n"
          : `\n[ardent] Flash échoué (code ${code})\n`
      );
    });
  } catch (err) {
    job.lines.push(`[ardent] Impossible de lancer pio : ${err}\n`);
    job.done     = true;
    job.exitCode = -1;
  }

  return Response.json({ jobId });
}
