/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

/**
 * Next.js instrumentation hook — runs once on server startup.
 * Starts the MQTT ingestion service (Node.js runtime only).
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startMqttIngestion } = await import("./lib/mqtt-ingestion");
    startMqttIngestion();
  }
}
