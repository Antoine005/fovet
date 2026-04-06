/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent-ai.fr
 */

/**
 * GET /api/forge/jobs/[id]/stream — SSE stream of Forge job logs.
 *
 * Events:
 *   log    — new log chunk (JSON string)
 *   status — { status, progress } (every tick)
 *   done   — { status } when terminal state reached
 *   ping   — heartbeat every 5s
 */

import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const encoder = new TextEncoder();

  const body = new ReadableStream({
    start(controller) {
      let logOffset = 0;

      const send = (event: string, data: string) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch { /* stream closed */ }
      };

      async function tick() {
        try {
          const job = await prisma.forgeJob.findUnique({
            where:  { id },
            select: { logs: true, status: true, progress: true },
          });

          if (!job) {
            send("done", JSON.stringify({ status: "NOT_FOUND" }));
            controller.close();
            return;
          }

          // Send new log chunk
          const logs = job.logs ?? "";
          if (logs.length > logOffset) {
            send("log", JSON.stringify(logs.slice(logOffset)));
            logOffset = logs.length;
          }

          // Send status update
          send("status", JSON.stringify({ status: job.status, progress: job.progress }));

          // Close on terminal state
          if (job.status === "DONE" || job.status === "FAILED" || job.status === "CANCELLED") {
            send("done", JSON.stringify({ status: job.status }));
            clearInterval(heartbeatId);
            controller.close();
            return;
          }

          setTimeout(tick, 500);
        } catch {
          clearInterval(heartbeatId);
          try { controller.close(); } catch { /* already closed */ }
        }
      }

      // Heartbeat every 5s
      const heartbeatId = setInterval(() => {
        send("ping", "0");
      }, 5_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeatId);
        try { controller.close(); } catch { /* already closed */ }
      });

      // Start immediately
      send("ping", "0");
      void tick();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
