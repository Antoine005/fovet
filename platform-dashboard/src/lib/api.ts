/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { sign, verify } from "hono/jwt";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { emitReading, subscribeToReadings, subscribeToAllReadings } from "@/lib/event-bus";
import { checkRateLimit, loginBucket } from "@/lib/rate-limiter";
import { getMqttStatus } from "@/lib/mqtt-ingestion";
import { runJanitor, startJanitorScheduler } from "@/lib/device-janitor";
import { spawn, exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { flashJobs } from "@/lib/flash-jobs";

// Re-export loginBucket so api.test.ts can clear it between tests
export { loginBucket };

// DEV: fallback so the module loads even without JWT_SECRET in .env
const jwtSecret = process.env.JWT_SECRET ?? "dev-bypass-secret";

const ACCESS_TOKEN_TTL  = 60 * 60 * 24;       // 1 day
const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30;  // 30 days

export const app = new Hono().basePath("/api");

// -------------------------------------------------------------------------
// CORS — allow one or more configured origins
//
// ALLOWED_ORIGIN supports comma-separated values for multi-origin setups:
//   ALLOWED_ORIGIN=https://watch.ardent.io,https://watch-staging.ardent.io
// -------------------------------------------------------------------------
const _allowedOrigins = (process.env.ALLOWED_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  "/*",
  cors({
    origin: _allowedOrigins.length === 1 ? _allowedOrigins[0] : _allowedOrigins,
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// -------------------------------------------------------------------------
// Cookie auth — protect all routes except /health and /auth/*
// -------------------------------------------------------------------------
const cookieAuth: MiddlewareHandler = async (c, next) => {
  if (process.env.NODE_ENV === "development") return next();
  const token = getCookie(c, "ard_token");
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  try {
    await verify(token, jwtSecret, "HS256");
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};

app.use("/devices/*", cookieAuth);
app.use("/alerts/*", cookieAuth);
app.use("/pti/*", cookieAuth);
app.use("/fleet/*", cookieAuth);
app.use("/workers/*", cookieAuth);
app.use("/forge/*", cookieAuth);

// -------------------------------------------------------------------------
// Rate limiting — /auth/token: max 5 attempts per 15 min per IP
//
// Implemented in src/lib/rate-limiter.ts:
//   - Redis-backed (REDIS_URL set): INCR + EXPIRE — safe for multi-instance
//   - In-memory fallback (no REDIS_URL): single-instance / dev only
//
// To enable Redis in production:
//   1. Set REDIS_URL in .env (see .env.example)
//   2. Uncomment the redis service in docker-compose.yml
// -------------------------------------------------------------------------

// -------------------------------------------------------------------------
// Zod schemas
// -------------------------------------------------------------------------
const AuthSchema = z.object({
  password: z.string().min(1),
});

const DeviceSchema = z.object({
  name: z.string().min(1).max(100),
  mqttClientId: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  location: z.string().max(200).optional(),
});

// -------------------------------------------------------------------------
// GET /api/health — public (lightweight ping)
// -------------------------------------------------------------------------
app.get("/health", (c) => c.json({ status: "ok", service: "ardent-watch" }));

// Start background janitor (no-op if already started — module is a singleton)
startJanitorScheduler();

// -------------------------------------------------------------------------
// GET /api/healthz — extended health check (MQTT + DB) — public
// Used by Nginx upstream check and monitoring tools.
// Returns 200 if all subsystems are up, 503 otherwise.
// -------------------------------------------------------------------------
app.get("/healthz", async (c) => {
  const mqtt = getMqttStatus();

  let db: "ok" | "error" = "error";
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = "ok";
  } catch {
    // db remains "error"
  }

  const healthy = db === "ok";
  return c.json(
    {
      status: healthy ? (mqtt.connected ? "ok" : "warning") : "degraded",
      mqtt: { connected: mqtt.connected, broker: mqtt.broker },
      db,
    },
    healthy ? 200 : 503,
  );
});

// -------------------------------------------------------------------------
// POST /api/auth/token — exchange dashboard password for JWT
// -------------------------------------------------------------------------
app.post("/auth/token", async (c) => {
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    c.req.header("x-real-ip") ??
    "unknown";

  if (!await checkRateLimit(ip)) {
    return c.json({ error: "Too many attempts — retry in 15 minutes" }, 429);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = AuthSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const dashboardPassword = process.env.DASHBOARD_PASSWORD;
  if (!dashboardPassword || parsed.data.password !== dashboardPassword) {
    return c.json({ error: "Invalid password" }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
    { role: "dashboard", type: "access", exp: now + ACCESS_TOKEN_TTL },
    jwtSecret,
    "HS256"
  );
  const refreshToken = await sign(
    { role: "dashboard", type: "refresh", exp: now + REFRESH_TOKEN_TTL },
    jwtSecret,
    "HS256"
  );

  const cookieOpts = {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
  setCookie(c, "ard_token",   token,        { ...cookieOpts, maxAge: ACCESS_TOKEN_TTL });
  setCookie(c, "ard_refresh", refreshToken, { ...cookieOpts, maxAge: REFRESH_TOKEN_TTL });
  return c.json({ ok: true });
});

// -------------------------------------------------------------------------
// POST /api/auth/refresh — exchange refresh token for a new access token
// -------------------------------------------------------------------------
app.post("/auth/refresh", async (c) => {
  const refreshToken = getCookie(c, "ard_refresh");
  if (!refreshToken) return c.json({ error: "Unauthorized" }, 401);

  try {
    const payload = await verify(refreshToken, jwtSecret, "HS256") as { role?: string; type?: string };
    if (payload.role !== "dashboard" || payload.type !== "refresh") {
      return c.json({ error: "Unauthorized" }, 401);
    }
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = await sign(
    { role: "dashboard", type: "access", exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL },
    jwtSecret,
    "HS256"
  );
  setCookie(c, "ard_token", token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ACCESS_TOKEN_TTL,
  });
  return c.json({ ok: true });
});

// -------------------------------------------------------------------------
// POST /api/auth/logout — clear both auth cookies
// -------------------------------------------------------------------------
app.post("/auth/logout", (c) => {
  deleteCookie(c, "ard_token",   { path: "/" });
  deleteCookie(c, "ard_refresh", { path: "/" });
  return c.json({ ok: true });
});

// -------------------------------------------------------------------------
// POST /api/devices/janitor — run stale device cleanup immediately
// -------------------------------------------------------------------------
app.post("/devices/janitor", cookieAuth, async (c) => {
  const result = await runJanitor();
  return c.json(result);
});

// -------------------------------------------------------------------------
// GET /api/devices — list all active devices
// -------------------------------------------------------------------------
app.get("/devices", cookieAuth, async (c) => {
  const devices = await prisma.device.findMany({
    where: { active: true },
    orderBy: { createdAt: "desc" },
    include: {
      readings: {
        take: 1,
        orderBy: { timestamp: "desc" },
        select: { timestamp: true, firmware: true, modelId: true, unit: true, label: true },
      },
      _count: { select: { readings: true } },
    },
  });
  return c.json(
    devices.map(({ readings, _count, ...d }) => ({
      ...d,
      lastReadingAt:    readings[0]?.timestamp ?? null,
      readingCount:     _count.readings,
      latestFirmware:   readings[0]?.firmware  ?? null,
      latestModelId:    readings[0]?.modelId   ?? null,
      latestUnit:       readings[0]?.unit      ?? null,
      latestLabel:      readings[0]?.label     ?? null,
    }))
  );
});

// -------------------------------------------------------------------------
// GET /api/devices/:id — single device detail
// -------------------------------------------------------------------------
app.get("/devices/:id", cookieAuth, async (c) => {
  const { id } = c.req.param();
  const device = await prisma.device.findUnique({
    where: { id },
    include: {
      readings: {
        take: 1,
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      },
      _count: { select: { readings: true } },
    },
  });
  if (!device) return c.json({ error: "Device not found" }, 404);
  const { readings, _count, ...d } = device;
  return c.json({ ...d, lastReadingAt: readings[0]?.timestamp ?? null, readingCount: _count.readings });
});

// -------------------------------------------------------------------------
// POST /api/devices — register a new device
// -------------------------------------------------------------------------
app.post("/devices", cookieAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = DeviceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
  }

  try {
    const device = await prisma.device.create({ data: parsed.data });
    return c.json(device, 201);
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return c.json({ error: "mqttClientId already exists" }, 409);
    }
    throw e;
  }
});

// -------------------------------------------------------------------------
// PATCH /api/devices/:id — update device fields (name, description, location, active)
// -------------------------------------------------------------------------
app.patch("/devices/:id", cookieAuth, async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => null);
  const PatchSchema = DeviceSchema.partial().refine(
    (d) => Object.keys(d).length > 0,
    { message: "At least one field required" }
  );
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
  }
  const existing = await prisma.device.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return c.json({ error: "Device not found" }, 404);
  const device = await prisma.device.update({ where: { id }, data: parsed.data });
  return c.json(device);
});

// -------------------------------------------------------------------------
// DELETE /api/devices/:id — remove a device and all its readings/alerts
// -------------------------------------------------------------------------
app.delete("/devices/:id", cookieAuth, async (c) => {
  const { id } = c.req.param();
  const existing = await prisma.device.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return c.json({ error: "Device not found" }, 404);
  await prisma.device.delete({ where: { id } });
  return c.json({ ok: true });
});

// -------------------------------------------------------------------------
// GET /api/devices/:id/readings — last N readings with cursor pagination
// ?limit=100&cursor=<bigint-id>  (cursor = last id from previous page, desc order)
// ?sensorType=HR|TEMP|IMU        (optional — filter by sensorType)
// -------------------------------------------------------------------------
app.get("/devices/:id/readings", cookieAuth, async (c) => {
  const { id } = c.req.param();
  const limitParam = c.req.query("limit");
  const rawLimit = limitParam !== undefined ? parseInt(limitParam, 10) : 100;
  if (limitParam !== undefined && (isNaN(rawLimit) || rawLimit <= 0)) {
    return c.json({ error: "Invalid limit — must be a positive integer" }, 400);
  }
  const limit = Math.min(rawLimit, 1000);
  const cursorParam    = c.req.query("cursor");
  const sensorTypeParam = c.req.query("sensorType") ?? null;

  const device = await prisma.device.findUnique({ where: { id }, select: { id: true } });
  if (!device) return c.json({ error: "Device not found" }, 404);

  // Validate cursor if provided
  let cursorId: bigint | undefined;
  if (cursorParam !== undefined) {
    try {
      cursorId = BigInt(cursorParam);
    } catch {
      return c.json({ error: "Invalid cursor" }, 400);
    }
    const cursorReading = await prisma.reading.findUnique({
      where: { id: cursorId },
      select: { id: true },
    });
    if (!cursorReading) return c.json({ error: "Cursor not found" }, 400);
  }

  // Fetch limit+1 to detect next page
  const rows = await prisma.reading.findMany({
    where: {
      deviceId: id,
      ...(sensorTypeParam ? { sensorType: sensorTypeParam } : {}),
    },
    orderBy: { timestamp: "desc" },
    take: limit + 1,
    ...(cursorId !== undefined && {
      cursor: { id: cursorId },
      skip: 1,
    }),
  });

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  // nextCursor = last item in desc order (oldest in this page), captured before reversing
  const nextCursor = hasMore ? String(data[data.length - 1].id) : null;
  // Serialize BigInt ids as strings, return in chronological order
  const serialized = data.reverse().map((r) => ({ ...r, id: String(r.id) }));

  return c.json({ data: serialized, pagination: { limit, hasMore, nextCursor } });
});

// -------------------------------------------------------------------------
// GET /api/devices/:id/stream — SSE stream of new readings
// -------------------------------------------------------------------------
app.get("/devices/:id/stream", cookieAuth, async (c) => {
  const { id } = c.req.param();

  const device = await prisma.device.findUnique({ where: { id }, select: { id: true } });
  if (!device) return c.json({ error: "Device not found" }, 404);

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "ping", data: "connected" });

    const cleanup = subscribeToReadings(id, async (reading) => {
      try {
        await stream.writeSSE({ event: "reading", data: JSON.stringify(reading) });
      } catch {
        // Stream already closed — unsubscribe to avoid further attempts
        cleanup();
      }
    });

    stream.onAbort(() => cleanup());

    // Keep alive with periodic heartbeat
    while (!stream.aborted) {
      await stream.sleep(30_000);
      if (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "heartbeat" });
      }
    }
  });
});

// -------------------------------------------------------------------------
// GET /api/devices/:id/alerts — unacknowledged alerts (paginated)
// ?limit=50  (default 50, max 200)
// ?cursor=<alert-id>  (cuid of last item received, for next page)
// -------------------------------------------------------------------------
app.get("/devices/:id/alerts", cookieAuth, async (c) => {
  const { id } = c.req.param();
  const rawLimit  = parseInt(c.req.query("limit") ?? "50", 10);
  const limit     = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);
  const cursorId  = c.req.query("cursor");

  const device = await prisma.device.findUnique({ where: { id }, select: { id: true } });
  if (!device) return c.json({ error: "Device not found" }, 404);

  if (cursorId) {
    const exists = await prisma.alert.findUnique({ where: { id: cursorId }, select: { id: true } });
    if (!exists) return c.json({ error: "Cursor not found" }, 400);
  }

  const rows = await prisma.alert.findMany({
    where: { deviceId: id, acknowledged: false },
    orderBy: { timestamp: "desc" },
    take: limit + 1,
    ...(cursorId && { cursor: { id: cursorId }, skip: 1 }),
  });

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? data[data.length - 1].id : null;

  return c.json({ data, pagination: { limit, hasMore, nextCursor } });
});

// -------------------------------------------------------------------------
// GET /api/fleet/alerts/recent — most recent alerts across all devices
// ?limit=50 (max 200)  ?cursor=<alert-id> (cuid, for pagination)
// ?level=DANGER  → only DANGER|CRITICAL alerts
// ?level=WARN    → only WARN|COLD alerts
// -------------------------------------------------------------------------
app.get("/fleet/alerts/recent", cookieAuth, async (c) => {
  const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
  const limit    = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);
  const cursorId = c.req.query("cursor");
  const levelFilter = c.req.query("level");  // "DANGER" | "WARN" | undefined
  if (levelFilter !== undefined && levelFilter !== "DANGER" && levelFilter !== "WARN") {
    return c.json({ error: "Invalid level — use 'DANGER' or 'WARN'" }, 400);
  }

  const levelWhere =
    levelFilter === "DANGER" ? { alertLevel: { in: ["DANGER", "CRITICAL"] } } :
    levelFilter === "WARN"   ? { alertLevel: { in: ["WARN",   "COLD"]     } } :
    undefined;

  if (cursorId) {
    const exists = await prisma.alert.findUnique({ where: { id: cursorId }, select: { id: true } });
    if (!exists) return c.json({ error: "Cursor not found" }, 400);
  }

  const rows = await prisma.alert.findMany({
    where: levelWhere,
    orderBy: { timestamp: "desc" },
    take: limit + 1,
    ...(cursorId && { cursor: { id: cursorId }, skip: 1 }),
    include: { device: { select: { name: true } } },
  });

  const hasMore    = rows.length > limit;
  const data       = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? data[data.length - 1].id : null;

  return c.json({
    data: data.map((a) => ({
      id:           a.id,
      deviceId:     a.deviceId,
      deviceName:   a.device.name,
      timestamp:    a.timestamp,
      value:        a.value,
      zScore:       a.zScore,
      threshold:    a.threshold,
      alertModule:  a.alertModule,
      alertLevel:   a.alertLevel,
      acknowledged: a.acknowledged,
    })),
    pagination: { limit, hasMore, nextCursor },
  });
});

// -------------------------------------------------------------------------
// GET /api/fleet/health — aggregated cross-module health per active device
//
// Returns for each device the count of unacknowledged alerts per module
// (PTI / FATIGUE / THERMAL) and the most recent alert timestamp per module.
// Used by the "Santé flotte" view.
// -------------------------------------------------------------------------
app.get("/fleet/health", cookieAuth, async (c) => {
  const devices = await prisma.device.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    include: {
      alerts: {
        where: { acknowledged: false },
        orderBy: { timestamp: "desc" },
        select: { alertModule: true, alertLevel: true, timestamp: true, ptiType: true },
      },
    },
  });

  return c.json(
    devices.map((d) => {
      const byModule = (module: string) => d.alerts.filter((a) => a.alertModule === module);

      const pti      = byModule("PTI");
      const fatigue  = byModule("FATIGUE");
      const thermal  = byModule("THERMAL");

      // Worst PTI level: FALL/SOS > MOTIONLESS > none
      const ptiFall       = pti.some((a) => a.ptiType === "FALL" || a.ptiType === "SOS");
      const ptiMotionless = pti.some((a) => a.ptiType === "MOTIONLESS");
      const ptiStatus     = ptiFall ? "CRITICAL" : ptiMotionless ? "WARN" : pti.length > 0 ? "WARN" : "OK";

      // Worst level for FATIGUE / THERMAL: respect Pulse level ordering
      const worstLevel = (alerts: { alertLevel: string | null }[]) => {
        if (alerts.some((a) => a.alertLevel === "CRITICAL" || a.alertLevel === "DANGER")) return "DANGER";
        if (alerts.some((a) => a.alertLevel === "WARN" || a.alertLevel === "COLD")) return "WARN";
        return alerts.length > 0 ? "WARN" : "OK";
      };

      return {
        id:           d.id,
        name:         d.name,
        location:     d.location,
        mqttClientId: d.mqttClientId,
        modules: {
          PTI:     { status: ptiStatus,              count: pti.length,     lastAt: pti[0]?.timestamp     ?? null },
          FATIGUE: { status: worstLevel(fatigue),    count: fatigue.length, lastAt: fatigue[0]?.timestamp ?? null },
          THERMAL: { status: worstLevel(thermal),    count: thermal.length, lastAt: thermal[0]?.timestamp ?? null },
        },
      };
    })
  );
});

// -------------------------------------------------------------------------
// GET /api/pti/fleet — all active workers + their unacknowledged PTI alerts
// -------------------------------------------------------------------------
app.get("/pti/fleet", cookieAuth, async (c) => {
  const devices = await prisma.device.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    include: {
      alerts: {
        where: { acknowledged: false, ptiType: { not: null } },
        orderBy: { timestamp: "desc" },
      },
    },
  });

  return c.json(
    devices.map((d) => ({
      id:           d.id,
      name:         d.name,
      location:     d.location,
      mqttClientId: d.mqttClientId,
      alertsByType: {
        FALL:       d.alerts.filter((a) => a.ptiType === "FALL").length,
        MOTIONLESS: d.alerts.filter((a) => a.ptiType === "MOTIONLESS").length,
        SOS:        d.alerts.filter((a) => a.ptiType === "SOS").length,
      },
      lastAlertAt: d.alerts[0]?.timestamp ?? null,
    }))
  );
});

// -------------------------------------------------------------------------
// GET /api/pti/alerts/recent — recent PTI alerts across all workers
// ?limit=50 (max 200)
// -------------------------------------------------------------------------
app.get("/pti/alerts/recent", cookieAuth, async (c) => {
  const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);

  const alerts = await prisma.alert.findMany({
    where: { ptiType: { not: null } },
    orderBy: { timestamp: "desc" },
    take: limit,
    include: { device: { select: { name: true } } },
  });

  return c.json(
    alerts.map((a) => ({
      id:           a.id,
      deviceId:     a.deviceId,
      deviceName:   a.device.name,
      ptiType:      a.ptiType,
      timestamp:    a.timestamp,
      acknowledged: a.acknowledged,
    }))
  );
});

// -------------------------------------------------------------------------
// GET /api/devices/:id/report — session report for compliance / end-of-shift
//
// Query params:
//   from    ISO 8601 start (default: 8 h ago)
//   to      ISO 8601 end   (default: now)
//   format  "json" (default) | "csv"
//
// JSON response: device info, session stats per module, full alert list
// CSV  response: flat table of all readings in the window (for Excel/import)
// -------------------------------------------------------------------------
app.get("/devices/:id/report", cookieAuth, async (c) => {
  const { id }   = c.req.param();
  const format   = (c.req.query("format") ?? "json").toLowerCase();
  if (format !== "json" && format !== "csv") {
    return c.json({ error: "Invalid format — use 'json' or 'csv'" }, 400);
  }
  const fromStr  = c.req.query("from");
  const toStr    = c.req.query("to");

  const toDate   = toStr   ? new Date(toStr)   : new Date();
  const fromDate = fromStr ? new Date(fromStr)  : new Date(toDate.getTime() - 8 * 60 * 60 * 1000);

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return c.json({ error: "Invalid date — use ISO 8601 format" }, 400);
  }
  if (fromDate >= toDate) {
    return c.json({ error: "'from' must be before 'to'" }, 400);
  }
  // Cap window at 7 days to prevent runaway queries
  if (toDate.getTime() - fromDate.getTime() > 7 * 24 * 60 * 60 * 1000) {
    return c.json({ error: "Window cannot exceed 7 days" }, 400);
  }

  const device = await prisma.device.findUnique({
    where: { id },
    select: { id: true, name: true, location: true, mqttClientId: true },
  });
  if (!device) return c.json({ error: "Device not found" }, 404);

  const [readings, alerts] = await Promise.all([
    prisma.reading.findMany({
      where: { deviceId: id, timestamp: { gte: fromDate, lte: toDate } },
      orderBy: { timestamp: "asc" },
      select: {
        id: true, timestamp: true, sensorType: true,
        value: true, value2: true, mean: true, stddev: true,
        zScore: true, isAnomaly: true,
      },
    }),
    prisma.alert.findMany({
      where: { deviceId: id, timestamp: { gte: fromDate, lte: toDate } },
      orderBy: { timestamp: "asc" },
      select: {
        id: true, timestamp: true, value: true, zScore: true,
        alertModule: true, alertLevel: true, ptiType: true, acknowledged: true,
      },
    }),
  ]);

  // ----- CSV format --------------------------------------------------------
  if (format === "csv") {
    const header = "id,timestamp,sensorType,value,value2,mean,stddev,zScore,isAnomaly";
    const rows = readings.map((r) =>
      [
        String(r.id),
        r.timestamp.toISOString(),
        r.sensorType ?? "",
        r.value,
        r.value2 ?? "",
        r.mean,
        r.stddev,
        r.zScore,
        r.isAnomaly ? "1" : "0",
      ].join(",")
    );
    const csv      = [header, ...rows].join("\r\n");
    const filename = `ard_${device.mqttClientId}_${fromDate.toISOString().slice(0, 10)}.csv`;
    return new Response(csv, {
      headers: {
        "Content-Type":        "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  // ----- JSON format -------------------------------------------------------
  const durationMin = Math.round((toDate.getTime() - fromDate.getTime()) / 60_000);

  // Stats helper
  const moduleNames = ["IMU", "HR", "TEMP"] as const;
  const moduleStats = Object.fromEntries(
    moduleNames.map((mod) => {
      const r = readings.filter((x) => x.sensorType === mod);
      const a = alerts.filter((x)  => x.alertModule === (mod === "IMU" ? "PTI" : mod === "HR" ? "FATIGUE" : "THERMAL"));
      const vals = r.map((x) => x.value);
      const stats = vals.length > 0
        ? {
            min:  Math.min(...vals),
            max:  Math.max(...vals),
            mean: vals.reduce((s, v) => s + v, 0) / vals.length,
          }
        : null;
      return [mod, {
        readings:  r.length,
        anomalies: r.filter((x) => x.isAnomaly).length,
        alerts:    a.length,
        stats,
      }];
    })
  );

  const alertsByLevel = alerts.reduce<Record<string, number>>((acc, a) => {
    const key = a.alertLevel ?? "LEGACY";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return c.json({
    device,
    session: {
      from:            fromDate.toISOString(),
      to:              toDate.toISOString(),
      durationMinutes: durationMin,
    },
    summary: {
      totalReadings: readings.length,
      totalAlerts:   alerts.length,
      modules:       moduleStats,
      alertsByLevel,
    },
    alerts,
    generatedAt: new Date().toISOString(),
  });
});

// -------------------------------------------------------------------------
// GET /api/workers/:deviceId/summary — cross-module summary for one device
//
// Returns:
//  - device metadata
//  - PTI: unacknowledged alert counts by type + last alert
//  - FATIGUE: last 50 readings with sensorType HR (for EMA computation on client)
//  - THERMAL: last 50 readings with sensorType TEMP (for EMA + WBGT on client)
//  - Recent alerts (last 20, any module) for timeline
// -------------------------------------------------------------------------
app.get("/workers/:deviceId/summary", cookieAuth, async (c) => {
  const { deviceId } = c.req.param();

  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { id: true, name: true, location: true, mqttClientId: true, active: true },
  });
  if (!device) return c.json({ error: "Device not found" }, 404);

  const [ptiAlerts, hrReadings, tempReadings, recentAlerts] = await Promise.all([
    // Unacknowledged PTI alerts
    prisma.alert.findMany({
      where: { deviceId, acknowledged: false, ptiType: { not: null } },
      orderBy: { timestamp: "desc" },
      select: { id: true, ptiType: true, timestamp: true },
    }),
    // Latest HR readings (FATIGUE module)
    prisma.reading.findMany({
      where: { deviceId, sensorType: "HR" },
      orderBy: { timestamp: "desc" },
      take: 50,
      select: { id: true, value: true, timestamp: true },
    }),
    // Latest TEMP readings (THERMAL module)
    prisma.reading.findMany({
      where: { deviceId, sensorType: "TEMP" },
      orderBy: { timestamp: "desc" },
      take: 50,
      select: { id: true, value: true, value2: true, timestamp: true },
    }),
    // Last 20 alerts (any module) for timeline
    prisma.alert.findMany({
      where: { deviceId },
      orderBy: { timestamp: "desc" },
      take: 20,
      select: {
        id: true, timestamp: true, value: true, zScore: true,
        ptiType: true, alertModule: true, alertLevel: true, acknowledged: true,
      },
    }),
  ]);

  const ptiByType = {
    FALL:       ptiAlerts.filter((a) => a.ptiType === "FALL").length,
    MOTIONLESS: ptiAlerts.filter((a) => a.ptiType === "MOTIONLESS").length,
    SOS:        ptiAlerts.filter((a) => a.ptiType === "SOS").length,
  };

  return c.json({
    device,
    pti: {
      alertsByType: ptiByType,
      lastAlertAt: ptiAlerts[0]?.timestamp ?? null,
    },
    fatigue: {
      readings: hrReadings.map((r) => ({ ...r, id: String(r.id) })).reverse(),
    },
    thermal: {
      readings: tempReadings.map((r) => ({ ...r, id: String(r.id) })).reverse(),
    },
    recentAlerts,
  });
});

// -------------------------------------------------------------------------
// PATCH /api/alerts/:id/ack — acknowledge an alert
// -------------------------------------------------------------------------
app.patch("/alerts/:id/ack", cookieAuth, async (c) => {
  const { id } = c.req.param();
  const existing = await prisma.alert.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return c.json({ error: "Alert not found" }, 404);

  const alert = await prisma.alert.update({
    where: { id },
    data: { acknowledged: true, acknowledgedAt: new Date() },
  });
  return c.json(alert);
});

// =========================================================================
// FORGE — Model registry, training jobs, drift scores, OTA deploy, audit
// =========================================================================

// Zod schemas for Forge
const ForgeModelSchema = z.object({
  name:      z.string().min(1).max(100),
  type:      z.string().min(1).max(20),
  version:   z.string().min(1).max(50),
  status:    z.enum(["PROD", "TRAIN", "ARCH"]),
  sizeKb:    z.number().positive().optional(),
  latencyMs: z.number().positive().optional(),
  accuracy:  z.number().min(0).max(100).optional(),
});

const ForgeDataSourceSchema = z.object({
  type:      z.enum(["csv", "synthetic", "db"]),
  // csv / db-capture
  dataPath:  z.string().optional(),
  columns:   z.array(z.string()).optional(),
  // synthetic
  signal:    z.enum(["sine", "random_walk", "constant"]).optional(),
  nSamples:  z.number().int().min(50).max(50000).optional(),
  noiseStd:  z.number().min(0).max(10).optional(),
  anomalyRate: z.number().min(0).max(0.5).optional(),
  anomalyMag:  z.number().min(1).max(20).optional(),
}).optional();

const ForgeJobSchema = z.object({
  baseModelId:     z.string().optional(),
  totalEpochs:     z.number().int().min(1).max(1000).default(50),
  datasetSessions: z.number().int().positive().optional(),
  dataFrom:        z.string().optional(),
  dataTo:          z.string().optional(),
  profile:         z.string().optional(),
  config:          z.string().regex(/^[\w\-]+\.yaml$/).optional(),
  // New: data source from Forge Studio
  dataSource:      ForgeDataSourceSchema,
  algo:            z.string().optional(),
  threshold:       z.number().optional(),
  minSamples:      z.number().int().optional(),
});

// Monorepo root — platform-dashboard is one level below root
const REPO_ROOT     = path.resolve(process.cwd(), "..");
const CONFIGS_DIR   = path.join(REPO_ROOT, "automl-pipeline", "configs");
const UV_EXE        = process.env.UV_PATH ?? "uv";
const execAsync  = promisify(exec);
const AUTOML_DIR = path.join(REPO_ROOT, "automl-pipeline");
const EDGE_CORE_DIR = path.join(REPO_ROOT, "edge-core");

const ForgeDeploySchema = z.object({
  modelId:   z.string().min(1),
  deviceIds: z.array(z.string().min(1)).min(1),
});

const ForgeValidateSchema = z.object({
  decision: z.enum(["PROMOTE", "REJECT"]),
  actor:    z.string().min(1).max(100),
});

// -------------------------------------------------------------------------
// GET /api/forge/algorithms — dynamic list from forge CLI
// -------------------------------------------------------------------------
app.get("/forge/algorithms", async (c) => {
  try {
    const { stdout } = await execAsync(
      `${UV_EXE} run forge algorithms`,
      { cwd: AUTOML_DIR, timeout: 12000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } }
    );
    return c.json(JSON.parse(stdout.trim()));
  } catch {
    // Fallback static list if CLI unavailable
    return c.json([
      { id: "zscore",    name: "Z-Score",           export_format: "c_header", ram_bytes_estimate: "16–64",      params: [{ key: "threshold_sigma", type: "float", default: 3.0, min: 1.0, max: 6.0 }, { key: "min_samples", type: "int", default: 30, min: 10, max: 512 }] },
      { id: "ewma_drift",name: "Seuil adaptatif",   export_format: "c_header", ram_bytes_estimate: "32",         params: [{ key: "alpha_fast", type: "float", default: 0.1, min: 0.01, max: 0.5 }] },
      { id: "mad",       name: "MAD",               export_format: "c_header", ram_bytes_estimate: "64–256",     params: [{ key: "win_size", type: "int", default: 32, min: 4, max: 128 }] },
      { id: "autoencoder",name: "AutoEncoder",      export_format: "tflite",   ram_bytes_estimate: "8000–32000", params: [{ key: "epochs", type: "int", default: 50, min: 5, max: 200 }] },
    ]);
  }
});

// -------------------------------------------------------------------------
// GET /api/forge/configs — list available YAML pipeline configs
// -------------------------------------------------------------------------
app.get("/forge/configs", (c) => {
  try {
    const files = fs.readdirSync(CONFIGS_DIR)
      .filter((f) => f.endsWith(".yaml"))
      .sort();
    return c.json(files.map((f) => ({ filename: f, label: f.replace(".yaml", "") })));
  } catch {
    return c.json([]);
  }
});

// -------------------------------------------------------------------------
// GET /api/forge/models — list all models
// -------------------------------------------------------------------------
app.get("/forge/models", async (c) => {
  const models = await prisma.forgeModel.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  return c.json(models);
});

// -------------------------------------------------------------------------
// GET /api/forge/models/:id — single model detail
// -------------------------------------------------------------------------
app.get("/forge/models/:id", async (c) => {
  const { id } = c.req.param();
  const model = await prisma.forgeModel.findUnique({
    where: { id },
    include: {
      jobs:    { orderBy: { createdAt: "desc" }, take: 10 },
      deploys: { orderBy: { deployedAt: "desc" }, take: 5 },
    },
  });
  if (!model) return c.json({ error: "Model not found" }, 404);
  return c.json(model);
});

// -------------------------------------------------------------------------
// GET /api/forge/jobs — job history (most recent first)
// ?status=RUNNING  — filter by status
// -------------------------------------------------------------------------
app.get("/forge/jobs", async (c) => {
  const statusFilter = c.req.query("status");
  const VALID_JOB_STATUSES = new Set(["RUNNING", "DONE", "FAILED", "CANCELLED"]);
  if (statusFilter !== undefined && !VALID_JOB_STATUSES.has(statusFilter)) {
    return c.json({ error: "Invalid status — use RUNNING, DONE, FAILED or CANCELLED" }, 400);
  }

  const jobs = await prisma.forgeJob.findMany({
    where: statusFilter ? { status: statusFilter } : undefined,
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { model: { select: { name: true, version: true, type: true } } },
  });
  return c.json(jobs);
});

// -------------------------------------------------------------------------
// GET /api/forge/jobs/:id/logs — logs for a specific job
// -------------------------------------------------------------------------
app.get("/forge/jobs/:id/logs", async (c) => {
  const { id } = c.req.param();
  const job = await prisma.forgeJob.findUnique({
    where: { id },
    select: { id: true, jobRef: true, logs: true, status: true },
  });
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

// -------------------------------------------------------------------------
// POST /api/forge/jobs — launch a new training job
// -------------------------------------------------------------------------
app.post("/forge/jobs", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ForgeJobSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
  }

  // Generate a sequential job ref based on last job
  const lastJob = await prisma.forgeJob.findFirst({ orderBy: { createdAt: "desc" }, select: { jobRef: true } });
  const lastNum = lastJob ? parseInt(lastJob.jobRef.replace("#JB-", ""), 10) : 0;
  const jobRef  = `#JB-${String(lastNum + 1).padStart(4, "0")}`;

  const job = await prisma.forgeJob.create({
    data: {
      jobRef,
      modelId:         parsed.data.baseModelId ?? null,
      status:          "RUNNING",
      progress:        0,
      currentEpoch:    0,
      totalEpochs:     parsed.data.totalEpochs,
      datasetSessions: parsed.data.datasetSessions ?? null,
      startedAt:       new Date(),
    },
  });

  // Append audit entry
  await prisma.forgeAudit.create({
    data: {
      actor:     "system",
      action:    "JOB_START",
      label:     `Job ${jobRef} lancé`,
      jobRef,
    },
  });

  // ── Resolve config path (static YAML or generated from dataSource) ──────────
  let resolvedConfig: string | null = null;

  if (parsed.data.dataSource) {
    // Generate YAML from Forge Studio data source
    ensureDir(CONFIGS_GEN_DIR);
    const ds       = parsed.data.dataSource;
    const genName  = `forge_studio_${job.id}`;
    const outputDir = path.join(REPO_ROOT, "automl-pipeline", "outputs", job.id);
    const yaml = generateForgeYaml({
      name:        genName,
      source:      ds.type === "synthetic" ? "synthetic" : "csv",
      csvPath:     ds.dataPath,
      columns:     ds.columns ?? ["value"],
      signal:      ds.signal ?? "sine",
      nSamples:    ds.nSamples ?? 1000,
      noiseStd:    ds.noiseStd ?? 0.1,
      anomalyRate: ds.anomalyRate ?? 0.05,
      anomalyMag:  ds.anomalyMag ?? 5.0,
      algo:        parsed.data.algo ?? "zscore",
      threshold:   parsed.data.threshold ?? 3.0,
      minSamples:  parsed.data.minSamples ?? 30,
      epochs:      parsed.data.totalEpochs,
      outputDir,
    });
    const genConfigPath = path.join(CONFIGS_GEN_DIR, `${genName}.yaml`);
    fs.writeFileSync(genConfigPath, yaml, "utf8");
    resolvedConfig = genConfigPath;
  } else if (parsed.data.config) {
    resolvedConfig = path.join(CONFIGS_DIR, parsed.data.config);
  }

  // Spawn automl-pipeline CLI in background (fire and forget)
  if (resolvedConfig) {
    const configPath = resolvedConfig;
    const cliDir     = path.join(REPO_ROOT, "automl-pipeline");
    const jobId      = job.id;

    const proc = spawn(UV_EXE, ["run", "forge", "run", "--config", configPath], {
      cwd: cliDir,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let logBuffer = "";
    let stage = 0; // 0=data 1=training 2=exporting 3=done

    async function appendLog(chunk: string) {
      logBuffer += chunk;
      // Truncate to last 8000 chars to avoid huge DB writes
      if (logBuffer.length > 8000) logBuffer = logBuffer.slice(-8000);

      // Parse progress from output
      if (/training detectors/i.test(chunk)) stage = 1;
      if (/exporting/i.test(chunk))          stage = 2;

      // Extract metrics
      const metricMatch = logBuffer.match(/precision=([\d.]+)\s+recall=([\d.]+)\s+f1=([\d.]+)/i);
      const valAccuracy = metricMatch ? parseFloat(metricMatch[3]) : null;

      const progressMap = [10, 50, 80, 100];
      const progress    = progressMap[stage] ?? 0;

      try {
        await prisma.forgeJob.update({
          where: { id: jobId },
          data:  { logs: logBuffer, progress, ...(valAccuracy !== null ? { valAccuracy } : {}) },
        });
      } catch { /* job may have been deleted */ }
    }

    proc.stdout.on("data", (d: Buffer) => { void appendLog(d.toString("utf8")); });
    proc.stderr.on("data", (d: Buffer) => { void appendLog(d.toString("utf8")); });

    proc.on("close", async (code: number | null) => {
      const success = code === 0;
      const metricMatch = logBuffer.match(/precision=([\d.]+)\s+recall=([\d.]+)\s+f1=([\d.]+)/i);
      const valAccuracy = metricMatch ? parseFloat(metricMatch[3]) : null;

      try {
        await prisma.forgeJob.update({
          where: { id: jobId },
          data: {
            status:      success ? "DONE" : "FAILED",
            progress:    success ? 100 : undefined,
            finishedAt:  new Date(),
            logs:        logBuffer,
            ...(valAccuracy !== null ? { valAccuracy } : {}),
          },
        });
        await prisma.forgeAudit.create({
          data: {
            actor:  "system",
            action: success ? "JOB_DONE" : "JOB_FAILED",
            label:  `Job ${jobRef} ${success ? "terminé" : "échoué"} (config: ${parsed.data.config})`,
            jobRef,
          },
        });
      } catch { /* ignore */ }
    });

    proc.on("error", async (err: Error) => {
      try {
        await prisma.forgeJob.update({
          where: { id: jobId },
          data: { status: "FAILED", finishedAt: new Date(), logs: `Erreur lancement : ${err.message}` },
        });
      } catch { /* ignore */ }
    });
  }

  return c.json(job, 201);
});

// -------------------------------------------------------------------------
// PATCH /api/forge/jobs/:id/validate — promote to STAGING or reject
// -------------------------------------------------------------------------
app.patch("/forge/jobs/:id/validate", async (c) => {
  const { id } = c.req.param();
  const body   = await c.req.json().catch(() => null);
  const parsed = ForgeValidateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const job = await prisma.forgeJob.findUnique({ where: { id }, select: { id: true, jobRef: true, status: true, modelId: true } });
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.status !== "DONE") return c.json({ error: "Job must be DONE to validate" }, 400);

  const { decision, actor } = parsed.data;

  if (decision === "PROMOTE" && job.modelId) {
    await prisma.forgeModel.update({
      where: { id: job.modelId },
      data:  { status: "PROD" },
    });
  } else if (decision === "REJECT" && job.modelId) {
    await prisma.forgeModel.update({
      where: { id: job.modelId },
      data:  { status: "ARCH" },
    });
  }

  await prisma.forgeAudit.create({
    data: {
      actor,
      action:    decision === "PROMOTE" ? "PROMOTE" : "REJECT",
      label:     `${actor} a ${decision === "PROMOTE" ? "promu" : "rejeté"} le job ${job.jobRef}`,
      jobRef:    job.jobRef,
    },
  });

  return c.json({ ok: true, decision });
});

// -------------------------------------------------------------------------
// POST /api/forge/jobs/:id/deploy — generate config.h + pio flash (USB)
// -------------------------------------------------------------------------
const DeploySchema = z.object({
  deviceId: z.string().min(1),
  project:  z.string().regex(/^[\w-]+$/).default("zscore_demo"),
  port:     z.string().min(3).default("COM4"),
});

app.post("/forge/jobs/:id/deploy", async (c) => {
  const { id } = c.req.param();
  const body   = await c.req.json().catch(() => null);
  const parsed = DeploySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);

  const job = await prisma.forgeJob.findUnique({ where: { id }, select: { id: true, status: true, jobRef: true } });
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.status !== "DONE") return c.json({ error: `Job is ${job.status}, must be DONE to deploy` }, 409);

  const device = await prisma.device.findUnique({ where: { id: parsed.data.deviceId }, select: { mqttClientId: true } });
  if (!device) return c.json({ error: "Device not found" }, 404);

  const { project, port } = parsed.data;

  // Generate src/config.h from env vars
  const wifiSsid  = process.env.DEVICE_WIFI_SSID     ?? "";
  const wifiPass  = process.env.DEVICE_WIFI_PASSWORD  ?? "";
  const mqttHost  = process.env.DEVICE_MQTT_BROKER    ?? "192.168.1.20";
  const mqttPort  = process.env.DEVICE_MQTT_PORT      ?? "1883";
  const mqttUser  = process.env.DEVICE_MQTT_USER      ?? "ardent-device";
  const mqttPass  = process.env.DEVICE_MQTT_PASSWORD  ?? "";

  const configH = `\
/*
 * Généré par Ardent Watch lors du déploiement — ne pas éditer manuellement.
 * Job: ${job.jobRef} | Device: ${device.mqttClientId}
 */
#ifndef ARD_CONFIG_H
#define ARD_CONFIG_H

#define WIFI_SSID      "${wifiSsid}"
#define WIFI_PASSWORD  "${wifiPass}"

#define MQTT_BROKER    "${mqttHost}"
#define MQTT_PORT      ${mqttPort}
#define MQTT_USER      "${mqttUser}"
#define MQTT_PASSWORD  "${mqttPass}"

#define DEVICE_ID      "${device.mqttClientId}"
#define MODEL_ID       "${job.jobRef}"

#endif /* ARD_CONFIG_H */
`;

  const projectDir = path.join(EDGE_CORE_DIR, "examples", "esp32", project);
  const configPath = path.join(projectDir, "src", "config.h");

  try {
    fs.writeFileSync(configPath, configH, "utf-8");
  } catch (err) {
    return c.json({ error: `Failed to write config.h: ${err}` }, 500);
  }

  // Find pio executable
  let pioExe = process.env.PIO_PATH ?? "";
  if (!pioExe) {
    try {
      const { stdout } = await execAsync("where pio", { timeout: 2000 });
      pioExe = stdout.split("\n")[0].trim();
    } catch {
      const localApp = process.env.LOCALAPPDATA ?? "";
      for (const v of ["Python313", "Python312", "Python311"]) {
        const candidate = path.join(localApp, "Programs", "Python", v, "Scripts", "pio.exe");
        if (fs.existsSync(candidate)) { pioExe = candidate; break; }
      }
    }
  }
  if (!pioExe) pioExe = "pio";

  // Spawn pio upload via flash-jobs
  const { randomUUID } = await import("crypto");
  const flashJobId = randomUUID();
  flashJobs.cleanup();
  const fjob = flashJobs.create(flashJobId, project, project);

  const args = ["run", "--target", "upload", "--environment", project, "--upload-port", port];
  fjob.lines.push(`[ardent] Déploiement job ${job.jobRef} → ${device.mqttClientId}\n`);
  fjob.lines.push(`[ardent] config.h écrit dans ${configPath}\n`);
  fjob.lines.push(`[ardent] pio ${args.join(" ")}\n\n`);

  try {
    const proc = spawn(pioExe, args, {
      cwd: projectDir,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    proc.stdout.on("data", (d: Buffer) => fjob.lines.push(d.toString("utf8")));
    proc.stderr.on("data", (d: Buffer) => fjob.lines.push(d.toString("utf8")));
    proc.on("error", (err: Error) => {
      fjob.lines.push(`\n[ardent] Erreur : ${err.message}\n`);
      fjob.done = true; fjob.exitCode = -1;
    });
    proc.on("close", (code: number | null) => {
      fjob.done = true; fjob.exitCode = code;
      fjob.lines.push(code === 0 ? "\n[ardent] Flash terminé ✓\n" : `\n[ardent] Flash échoué (code ${code})\n`);
    });
  } catch (err) {
    fjob.lines.push(`[ardent] Impossible de lancer pio : ${err}\n`);
    fjob.done = true; fjob.exitCode = -1;
  }

  return c.json({ flashJobId });
});

// -------------------------------------------------------------------------
// GET /api/forge/drift — drift scores for all PROD models
// -------------------------------------------------------------------------
app.get("/forge/drift", async (c) => {
  const models = await prisma.forgeModel.findMany({
    where:   { status: "PROD", driftScore: { not: null } },
    orderBy: { driftScore: "desc" },
    select: {
      id: true, name: true, version: true,
      driftScore: true, driftLevel: true, driftNote: true,
    },
  });
  return c.json(
    models.map((m) => ({
      id:    m.id,
      name:  `${m.name} ${m.version}`,
      score: m.driftScore!,
      level: (m.driftLevel ?? "ok") as "ok" | "med" | "crit",
      note:  m.driftNote ?? "Stable",
    }))
  );
});

// -------------------------------------------------------------------------
// POST /api/forge/deploy — deploy a model to one or more devices via OTA
// -------------------------------------------------------------------------
app.post("/forge/deploy", async (c) => {
  const body   = await c.req.json().catch(() => null);
  const parsed = ForgeDeploySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const model = await prisma.forgeModel.findUnique({ where: { id: parsed.data.modelId } });
  if (!model) return c.json({ error: "Model not found" }, 404);

  // Generate deploy ref
  const lastDeploy  = await prisma.forgeDeploy.findFirst({ orderBy: { createdAt: "desc" }, select: { deployRef: true } });
  const lastDepNum  = lastDeploy ? parseInt(lastDeploy.deployRef.replace("#DEP-", ""), 10) : 0;
  const deployRef   = `#DEP-${String(lastDepNum + 1).padStart(4, "0")}`;

  // Initial results: all pending
  const results = Object.fromEntries(parsed.data.deviceIds.map((id) => [id, "pending"]));

  const deploy = await prisma.forgeDeploy.create({
    data: {
      deployRef,
      modelId:   model.id,
      deviceIds: JSON.stringify(parsed.data.deviceIds),
      status:    "PENDING",
      results:   JSON.stringify(results),
      deployedAt: new Date(),
    },
  });

  await prisma.forgeAudit.create({
    data: {
      actor:     "system",
      action:    "DEPLOY",
      label:     `Déploiement ${deployRef} — ${model.name} ${model.version} → ${parsed.data.deviceIds.length} dispositif(s)`,
      modelRef:  `${model.name} ${model.version}`,
      deployRef,
    },
  });

  // NOTE: in production, publish OTA MQTT messages here per device
  return c.json({ ...deploy, deviceIds: parsed.data.deviceIds, results }, 201);
});

// -------------------------------------------------------------------------
// GET /api/forge/deploys — list of past OTA deployments
// ?limit=20 (max 100)
// -------------------------------------------------------------------------
app.get("/forge/deploys", async (c) => {
  const rawLimit = parseInt(c.req.query("limit") ?? "20", 10);
  const limit    = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20, 100);

  const deploys = await prisma.forgeDeploy.findMany({
    orderBy: { deployedAt: "desc" },
    take: limit,
    include: { model: { select: { name: true, version: true } } },
  });

  return c.json(
    deploys.map((d) => ({
      ...d,
      deviceIds: JSON.parse(d.deviceIds) as string[],
      results:   d.results ? JSON.parse(d.results) as Record<string, string> : null,
    }))
  );
});

// -------------------------------------------------------------------------
// GET /api/forge/audit — recent audit log entries
// ?limit=50 (max 200)
// -------------------------------------------------------------------------
app.get("/forge/audit", async (c) => {
  const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
  const limit    = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);

  const entries = await prisma.forgeAudit.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return c.json(entries);
});

// -------------------------------------------------------------------------
// GET /api/forge/jobs/:id/download — serve generated C header or .tflite
// -------------------------------------------------------------------------
app.get("/forge/jobs/:id/download", async (c) => {
  const { id } = c.req.param();
  const job = await prisma.forgeJob.findUnique({
    where: { id },
    select: { id: true, status: true, jobRef: true },
  });
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.status !== "DONE") return c.json({ error: "Job not finished" }, 409);

  const AUTOML_DIR = path.resolve(process.cwd(), "..", "automl-pipeline");
  const outputDir  = path.join(AUTOML_DIR, "outputs", job.id);

  // Try all known output file names (Forge generates ard_*_config.h)
  const candidates = [
    { file: path.join(outputDir, "ard_zscore_config.h"),      mime: "text/plain", ext: ".h" },
    { file: path.join(outputDir, "ard_drift_config.h"),       mime: "text/plain", ext: ".h" },
    { file: path.join(outputDir, "ard_mad_config.h"),         mime: "text/plain", ext: ".h" },
    { file: path.join(outputDir, "model.h"),                  mime: "text/plain", ext: ".h" },
    { file: path.join(outputDir, "model.tflite"),             mime: "application/octet-stream", ext: ".tflite" },
  ];
  for (const { file, mime, ext } of candidates) {
    if (fs.existsSync(file)) {
      const buf = fs.readFileSync(file);
      const safe = job.jobRef.replace(/[^a-zA-Z0-9_-]/g, "_");
      return new Response(buf, {
        headers: {
          "Content-Type": mime,
          "Content-Disposition": `attachment; filename="ardent_model_${safe}${ext}"`,
        },
      });
    }
  }
  return c.json({ error: "No output file found — job may have failed or outputs were cleaned up" }, 404);
});

// -------------------------------------------------------------------------
// GET /api/events — global SSE stream of all readings (Live Monitor)
// -------------------------------------------------------------------------
app.get("/events", cookieAuth, (c) => {
  return streamSSE(c, async (stream) => {
    // Immediate ping to establish connection (prevents client timeout)
    await stream.writeSSE({ event: "ping", data: "connected" });

    const cleanup = subscribeToAllReadings(async (reading) => {
      try {
        await stream.writeSSE({ event: "reading", data: JSON.stringify(reading) });
      } catch {
        cleanup();
      }
    });

    stream.onAbort(() => cleanup());

    while (!stream.aborted) {
      await stream.sleep(30_000);
      if (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "heartbeat" });
      }
    }
  });
});

// -------------------------------------------------------------------------
// GET /api/readings — cross-device reading history with filters
// ?deviceId=<id>   optional — filter to one device
// ?from=<ISO>      optional — start datetime
// ?to=<ISO>        optional — end datetime
// ?anomalyOnly=1   optional — only anomalous readings
// ?limit=200       default 200, max 1000
// ?cursor=<bigint> optional — last id for pagination (desc)
// -------------------------------------------------------------------------
app.get("/readings", cookieAuth, async (c) => {
  const deviceId   = c.req.query("deviceId");
  const from       = c.req.query("from");
  const to         = c.req.query("to");
  const anomalyOnly = c.req.query("anomalyOnly") === "1";
  const rawLimit   = parseInt(c.req.query("limit") ?? "200", 10);
  const limit      = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 200, 1000);
  const cursorRaw  = c.req.query("cursor");
  const cursor     = cursorRaw ? BigInt(cursorRaw) : undefined;

  const where: Record<string, unknown> = {};
  if (deviceId) where.deviceId = deviceId;
  if (anomalyOnly) where.isAnomaly = true;
  if (from || to) {
    const ts: Record<string, Date> = {};
    if (from) ts.gte = new Date(from);
    if (to)   ts.lte = new Date(to);
    where.timestamp = ts;
  }

  const rows = await prisma.reading.findMany({
    where,
    orderBy: { id: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true, deviceId: true, sensorType: true, value: true,
      isAnomaly: true, zScore: true, firmware: true, modelId: true,
      unit: true, label: true, timestamp: true,
    },
  });

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? String(data[data.length - 1].id) : null;
  const serialized = data.map((r) => ({
    ...r,
    id: String(r.id),
    // Normalize to client-friendly names
    channel: r.sensorType,
    anomaly: r.isAnomaly,
    zscore: r.zScore,
    algo: r.firmware,
  }));

  return c.json({ data: serialized, pagination: { limit, hasMore, nextCursor } });
});

// -------------------------------------------------------------------------
// GET /api/readings/export — CSV export of reading history
// Same filters as GET /api/readings (deviceId, from, to, anomalyOnly)
// max 10 000 rows
// -------------------------------------------------------------------------
app.get("/readings/export", cookieAuth, async (c) => {
  const deviceId    = c.req.query("deviceId");
  const from        = c.req.query("from");
  const to          = c.req.query("to");
  const anomalyOnly = c.req.query("anomalyOnly") === "1";

  const where: Record<string, unknown> = {};
  if (deviceId) where.deviceId = deviceId;
  if (anomalyOnly) where.isAnomaly = true;
  if (from || to) {
    const ts: Record<string, Date> = {};
    if (from) ts.gte = new Date(from);
    if (to)   ts.lte = new Date(to);
    where.timestamp = ts;
  }

  const rows = await prisma.reading.findMany({
    where,
    orderBy: { timestamp: "asc" },
    take: 10_000,
    select: {
      id: true, deviceId: true, sensorType: true, value: true,
      isAnomaly: true, zScore: true, firmware: true, modelId: true,
      unit: true, label: true, timestamp: true,
    },
  });

  const header = "id,deviceId,sensorType,value,isAnomaly,zScore,firmware,modelId,unit,label,timestamp";
  const lines = rows.map((r) =>
    [
      String(r.id), r.deviceId, r.sensorType ?? "",
      r.value, r.isAnomaly ? "1" : "0", r.zScore ?? "",
      r.firmware ?? "", r.modelId ?? "", r.unit ?? "", r.label ?? "",
      r.timestamp.toISOString(),
    ].join(",")
  );
  const csv = [header, ...lines].join("\n");

  const filename = `ardent_readings_${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

// =============================================================================
// FORGE DATA STUDIO (G3)
// =============================================================================

const UPLOADS_DIR = path.resolve(process.cwd(), "..", "automl-pipeline", "data", "uploads");
const CONFIGS_GEN_DIR = path.resolve(process.cwd(), "..", "automl-pipeline", "configs", "generated");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Peek at first N lines of a CSV file → return columns + row count estimate.
 */
function csvMeta(filePath: string): { columns: string[]; rows: number } {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.trim().split(/\r?\n/);
  const header = lines[0]?.split(",").map((c) => c.trim().replace(/^"|"$/g, "")) ?? [];
  return { columns: header, rows: Math.max(0, lines.length - 1) };
}

/**
 * Generate a Forge YAML config string from a data source descriptor + algo + profile.
 */
function generateForgeYaml(opts: {
  name:       string;
  source:     "csv" | "synthetic";
  csvPath?:   string;
  columns:    string[];
  signal?:    string;
  nSamples?:  number;
  noiseStd?:  number;
  anomalyRate?: number;
  anomalyMag?:  number;
  algo:       string;
  threshold?: number;
  minSamples?: number;
  epochs?:    number;
  outputDir:  string;
}): string {
  const {
    name, source, csvPath, columns, signal = "sine",
    nSamples = 1000, noiseStd = 0.1, anomalyRate = 0.05, anomalyMag = 5.0,
    algo, threshold = 3.0, minSamples = 30, epochs = 50,
    outputDir,
  } = opts;

  const colYaml = columns.map((c) => `"${c}"`).join(", ");

  const dataBlock = source === "csv"
    ? `data:\n  source: csv\n  path: "${csvPath}"\n  columns: [${colYaml}]`
    : `data:\n  source: synthetic\n  signal: ${signal}\n  n_samples: ${nSamples}\n  noise_std: ${noiseStd}\n  anomaly_rate: ${anomalyRate}\n  anomaly_magnitude: ${anomalyMag}\n  columns: [${colYaml}]\n  seed: 42`;

  let detectorBlock = "";
  if (algo === "zscore") {
    detectorBlock = `detectors:\n  - type: zscore\n    threshold_sigma: ${threshold}\n    min_samples: ${minSamples}`;
  } else if (algo === "ewma_drift") {
    detectorBlock = `detectors:\n  - type: ewma_drift\n    alpha: 0.1\n    threshold_sigma: ${threshold}`;
  } else if (algo === "mad") {
    detectorBlock = `detectors:\n  - type: mad\n    threshold_mad: ${threshold}\n    window: 50`;
  } else if (algo === "autoencoder") {
    detectorBlock = `detectors:\n  - type: autoencoder\n    latent_dim: 4\n    epochs: ${epochs}\n    batch_size: 32\n    threshold_percentile: 95.0`;
  } else if (algo === "lstm_autoencoder") {
    detectorBlock = `detectors:\n  - type: lstm_autoencoder\n    seq_len: 20\n    latent_dim: 8\n    epochs: ${epochs}\n    batch_size: 32\n    threshold_percentile: 95.0`;
  } else {
    // isolation_forest or fallback
    detectorBlock = `detectors:\n  - type: isolation_forest\n    contamination: ${anomalyRate}`;
  }

  const exportTargets = ["autoencoder", "lstm_autoencoder"].includes(algo)
    ? "[tflite_micro, json_config]"
    : "[c_header, json_config]";

  return [
    `# Ardent Forge — auto-generated config`,
    `name: ${name}`,
    `description: "Généré par Ardent Watch Forge Studio"`,
    ``,
    dataBlock,
    ``,
    detectorBlock,
    ``,
    `split:\n  enabled: true\n  test_ratio: 0.2\n  random_state: 42`,
    ``,
    `export:\n  targets: ${exportTargets}\n  output_dir: ${outputDir}\n  quantization: float32`,
    ``,
    `report:\n  enabled: true\n  format: html\n  output_dir: reports`,
  ].join("\n");
}

// -------------------------------------------------------------------------
// POST /api/forge/data/upload — receive CSV file, save to uploads dir
// Body: multipart/form-data { file: File, columns?: string (comma-sep) }
// Returns: { dataPath, columns, rows, uploadId }
// -------------------------------------------------------------------------
app.post("/forge/data/upload", cookieAuth, async (c) => {
  ensureDir(UPLOADS_DIR);
  let formData: FormData;
  try {
    formData = await c.req.raw.formData();
  } catch {
    return c.json({ error: "Expected multipart/form-data" }, 400);
  }
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "No file field" }, 400);
  if (!file.name.endsWith(".csv")) return c.json({ error: "Only .csv files accepted" }, 400);
  if (file.size > 50 * 1024 * 1024) return c.json({ error: "File too large (max 50 MB)" }, 400);

  const uploadId  = crypto.randomUUID();
  const destPath  = path.join(UPLOADS_DIR, `${uploadId}.csv`);
  const buf       = await file.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buf));

  const { columns, rows } = csvMeta(destPath);
  // Return preview of first 5 data rows
  const raw     = fs.readFileSync(destPath, "utf8").trim().split(/\r?\n/);
  const preview = raw.slice(1, 6);

  return c.json({ uploadId, dataPath: destPath, columns, rows, preview });
});

// -------------------------------------------------------------------------
// POST /api/forge/data/capture — export readings from DB as CSV
// Body: { deviceId?, from?, to?, limit? }
// Returns: { dataPath, columns, rows, uploadId }
// -------------------------------------------------------------------------
app.post("/forge/data/capture", cookieAuth, async (c) => {
  ensureDir(UPLOADS_DIR);
  const body = await c.req.json().catch(() => ({})) as {
    deviceId?: string; from?: string; to?: string; limit?: number;
  };
  const rawLimit = Math.min(body.limit ?? 5000, 20_000);
  const where: Record<string, unknown> = {};
  if (body.deviceId) where.deviceId = body.deviceId;
  if (body.from || body.to) {
    const ts: Record<string, Date> = {};
    if (body.from) ts.gte = new Date(body.from);
    if (body.to)   ts.lte = new Date(body.to);
    where.timestamp = ts;
  }

  const rows = await prisma.reading.findMany({
    where,
    orderBy: { timestamp: "asc" },
    take: rawLimit,
    select: { timestamp: true, value: true, zScore: true, isAnomaly: true, sensorType: true, deviceId: true },
  });

  if (rows.length === 0) return c.json({ error: "Aucune donnée trouvée pour ces critères" }, 404);

  const header = "timestamp,value,zscore,is_anomaly,sensor_type,device_id";
  const lines  = rows.map((r) =>
    [r.timestamp.toISOString(), r.value, r.zScore, r.isAnomaly ? 1 : 0, r.sensorType ?? "", r.deviceId].join(",")
  );
  const csv = [header, ...lines].join("\n");

  const uploadId = crypto.randomUUID();
  const destPath = path.join(UPLOADS_DIR, `${uploadId}.csv`);
  fs.writeFileSync(destPath, csv, "utf8");

  return c.json({
    uploadId,
    dataPath: destPath,
    columns:  ["value"],  // Forge will use "value" column by default
    rows:     rows.length,
    preview:  lines.slice(0, 5),
  });
});

// =============================================================================
// SETTINGS (G9)
// =============================================================================

const SETTINGS_FILE = path.resolve(process.cwd(), "data", "settings.json");

const SETTINGS_DEFAULTS = {
  zscore_default_threshold:    3.0,
  min_samples_default:         30,
  device_inactive_days:        parseInt(process.env.DEVICE_INACTIVE_DAYS ?? "7", 10),
  device_purge_days:           parseInt(process.env.DEVICE_PURGE_DAYS    ?? "30", 10),
  alert_webhook_url:           process.env.ALERT_WEBHOOK_URL ?? "",
  alert_webhook_min_level:     process.env.ALERT_WEBHOOK_MIN_LEVEL ?? "DANGER",
};

type SettingsKey = keyof typeof SETTINGS_DEFAULTS;
const EDITABLE_KEYS = new Set<string>(Object.keys(SETTINGS_DEFAULTS));

function readSettings(): typeof SETTINGS_DEFAULTS {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    return { ...SETTINGS_DEFAULTS, ...(JSON.parse(raw) as Partial<typeof SETTINGS_DEFAULTS>) };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

function writeSettings(data: Partial<typeof SETTINGS_DEFAULTS>) {
  const current = readSettings();
  const next    = { ...current };
  for (const [k, v] of Object.entries(data)) {
    if (EDITABLE_KEYS.has(k)) (next as Record<string, unknown>)[k] = v;
  }
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

// -------------------------------------------------------------------------
// GET /api/settings — return current settings + env-level info (read-only)
// -------------------------------------------------------------------------
app.get("/settings", cookieAuth, async (c) => {
  const settings = readSettings();
  // Append read-only env info (masked for security)
  const mqttUrl = process.env.MQTT_BROKER_URL ?? "";
  const dbUrl   = process.env.DATABASE_URL ?? "";
  return c.json({
    ...settings,
    _readonly: {
      mqtt_broker_url: mqttUrl || "(non configuré)",
      mqtt_username:   process.env.MQTT_USERNAME ?? "",
      database_url:    dbUrl ? dbUrl.replace(/:([^:@]+)@/, ":****@") : "(non configuré)",
    },
  });
});

// -------------------------------------------------------------------------
// PATCH /api/settings — update editable settings
// -------------------------------------------------------------------------
app.patch("/settings", cookieAuth, async (c) => {
  const body = await c.req.json().catch(() => null) as Partial<typeof SETTINGS_DEFAULTS> | null;
  if (!body) return c.json({ error: "Invalid JSON" }, 400);
  // Strip unknown / read-only keys
  const safe: Partial<typeof SETTINGS_DEFAULTS> = {};
  for (const k of Object.keys(body) as SettingsKey[]) {
    if (EDITABLE_KEYS.has(k)) (safe as Record<string, unknown>)[k] = (body as Record<string, unknown>)[k];
  }
  const next = writeSettings(safe);
  return c.json(next);
});
