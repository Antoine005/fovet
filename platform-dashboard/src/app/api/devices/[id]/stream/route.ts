/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */

/**
 * GET /api/devices/:id/stream — SSE stream of live readings.
 *
 * Hono's streamSSE + hono/vercel adapter does not flush HTTP headers before
 * the first chunk in Next.js App Router, leaving EventSource hanging.
 * This dedicated Next.js route uses ReadableStream directly so headers are
 * sent immediately on connection.
 */

import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { subscribeToReadings } from "@/lib/event-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const device = await prisma.device.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!device) {
    return new Response(JSON.stringify({ error: "Device not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  const body = new ReadableStream({
    start(controller) {
      function send(event: string, data: string) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      }

      const cleanup = subscribeToReadings(id, (reading: unknown) => {
        try {
          send("reading", JSON.stringify(reading));
        } catch {
          cleanup();
        }
      });

      const heartbeat = setInterval(() => {
        try {
          send("ping", "heartbeat");
        } catch {
          clearInterval(heartbeat);
          cleanup();
        }
      }, 30_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        cleanup();
        controller.close();
      });
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "X-Accel-Buffering": "no", // disable Nginx buffering in production
    },
  });
}
