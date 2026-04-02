/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */

/**
 * GET /api/flash/stream/[jobId] — SSE stream of flash job output.
 *
 * Sends:
 *   event: log   — new output lines
 *   event: done  — job finished (data: exit code)
 *   event: ping  — heartbeat every 5s
 */

import { type NextRequest } from "next/server";
import { flashJobs }        from "@/lib/flash-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = flashJobs.get(jobId);

  if (!job) {
    return new Response(JSON.stringify({ error: "Job not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const j = job; // narrow to non-undefined for closure

  const body = new ReadableStream({
    start(controller) {
      let sent = 0; // index of last line sent

      function flush() {
        const slice = j.lines.slice(sent);
        if (slice.length > 0) {
          sent += slice.length;
          const text = slice.join("");
          controller.enqueue(encoder.encode(`event: log\ndata: ${JSON.stringify(text)}\n\n`));
        }
        if (j.done) {
          controller.enqueue(encoder.encode(`event: done\ndata: ${j.exitCode}\n\n`));
          clearInterval(timer);
          clearInterval(heartbeat);
          controller.close();
        }
      }

      // Poll job output every 200ms
      const timer = setInterval(flush, 200);

      // Heartbeat every 5s to keep connection alive
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`event: ping\ndata: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
          clearInterval(timer);
        }
      }, 5_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(timer);
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      });

      // Send already-buffered output immediately
      flush();
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
