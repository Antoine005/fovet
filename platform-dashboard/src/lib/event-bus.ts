/*
 * Fovet Vigie — In-process event bus for real-time SSE streaming
 *
 * Used to broadcast new readings from the MQTT ingestion service to
 * open SSE connections (GET /api/devices/:id/stream).
 *
 * Architecture:
 *   MQTT message → mqtt-ingestion.ts → emitReading() → EventEmitter
 *                                                          ↓
 *                                   SSE /stream endpoint ← subscribeToReadings()
 *                                          ↓
 *                                     Browser EventSource
 *
 * Singleton pattern: global.__fovetEventBus avoids duplicate emitters on
 * Next.js hot reloads in development.
 */

import { EventEmitter } from "events";

declare global {
  // eslint-disable-next-line no-var
  var __fovetEventBus: EventEmitter | undefined;
}

function getBus(): EventEmitter {
  if (!global.__fovetEventBus) {
    const bus = new EventEmitter();
    bus.setMaxListeners(200); // support many concurrent SSE clients
    global.__fovetEventBus = bus;
  }
  return global.__fovetEventBus;
}

export function emitReading(deviceId: string, reading: unknown): void {
  getBus().emit(`reading:${deviceId}`, reading);
}

/**
 * Subscribe to new readings for a specific device.
 * Returns a cleanup function — call it when the SSE client disconnects.
 */
export function subscribeToReadings(
  deviceId: string,
  callback: (reading: unknown) => void
): () => void {
  const event = `reading:${deviceId}`;
  getBus().on(event, callback);
  return () => getBus().off(event, callback);
}
