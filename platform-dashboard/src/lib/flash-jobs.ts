/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */

/**
 * In-memory singleton for flash job state.
 * Shared across /api/flash/start and /api/flash/stream/* Next.js routes
 * within the same Node.js process.
 */

export interface FlashJob {
  lines:    string[];
  done:     boolean;
  exitCode: number | null;
  env:      string;
  project:  string;
}

// Module-level singleton — survives between requests in the same process
const store = new Map<string, FlashJob>();

export const flashJobs = {
  create(id: string, env: string, project: string): FlashJob {
    const job: FlashJob = { lines: [], done: false, exitCode: null, env, project };
    store.set(id, job);
    return job;
  },
  get(id: string): FlashJob | undefined {
    return store.get(id);
  },
  // Keep store small — remove jobs older than 30 minutes
  cleanup() {
    if (store.size > 50) {
      const first = store.keys().next().value;
      if (first) store.delete(first);
    }
  },
};
