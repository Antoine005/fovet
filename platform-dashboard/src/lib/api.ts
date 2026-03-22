/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { sign, verify } from "hono/jwt";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { emitReading, subscribeToReadings } from "@/lib/event-bus";
import { checkRateLimit, loginBucket } from "@/lib/rate-limiter";

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
//   ALLOWED_ORIGIN=https://vigie.fovet.eu,https://vigie-staging.fovet.eu
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
// DEV BYPASS: auth disabled — all routes are public
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const cookieAuth: MiddlewareHandler = async (_c, next) => { await next(); };

app.use("/devices/*", cookieAuth);
app.use("/alerts/*", cookieAuth);
app.use("/pti/*", cookieAuth);
app.use("/fleet/*", cookieAuth);
app.use("/workers/*", cookieAuth);

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
// GET /api/health — public
// -------------------------------------------------------------------------
app.get("/health", (c) => c.json({ status: "ok", service: "fovet-vigie" }));

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
  setCookie(c, "fovet_token",   token,        { ...cookieOpts, maxAge: ACCESS_TOKEN_TTL });
  setCookie(c, "fovet_refresh", refreshToken, { ...cookieOpts, maxAge: REFRESH_TOKEN_TTL });
  return c.json({ ok: true });
});

// -------------------------------------------------------------------------
// POST /api/auth/refresh — exchange refresh token for a new access token
// -------------------------------------------------------------------------
app.post("/auth/refresh", async (c) => {
  const refreshToken = getCookie(c, "fovet_refresh");
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
  setCookie(c, "fovet_token", token, {
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
  deleteCookie(c, "fovet_token",   { path: "/" });
  deleteCookie(c, "fovet_refresh", { path: "/" });
  return c.json({ ok: true });
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
        select: { timestamp: true },
      },
    },
  });
  return c.json(
    devices.map(({ readings, ...d }) => ({
      ...d,
      lastReadingAt: readings[0]?.timestamp ?? null,
    }))
  );
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

  const device = await prisma.device.create({ data: parsed.data });
  return c.json(device, 201);
});

// -------------------------------------------------------------------------
// GET /api/devices/:id/readings — last N readings with cursor pagination
// ?limit=100&cursor=<bigint-id>  (cursor = last id from previous page, desc order)
// -------------------------------------------------------------------------
app.get("/devices/:id/readings", cookieAuth, async (c) => {
  const { id } = c.req.param();
  const rawLimit = parseInt(c.req.query("limit") ?? "100", 10);
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100, 1000);
  const cursorParam = c.req.query("cursor");

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
    where: { deviceId: id },
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
// -------------------------------------------------------------------------
app.get("/fleet/alerts/recent", cookieAuth, async (c) => {
  const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
  const limit    = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);
  const cursorId = c.req.query("cursor");

  if (cursorId) {
    const exists = await prisma.alert.findUnique({ where: { id: cursorId }, select: { id: true } });
    if (!exists) return c.json({ error: "Cursor not found" }, 400);
  }

  const rows = await prisma.alert.findMany({
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

      // Worst level for FATIGUE / THERMAL: respect Sentinelle level ordering
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
    const filename = `fovet_${device.mqttClientId}_${fromDate.toISOString().slice(0, 10)}.csv`;
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
