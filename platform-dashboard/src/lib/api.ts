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

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error("JWT_SECRET environment variable is not set");
}

export const app = new Hono().basePath("/api");

// -------------------------------------------------------------------------
// CORS — allow only configured origin
// -------------------------------------------------------------------------
app.use(
  "/*",
  cors({
    origin: process.env.ALLOWED_ORIGIN ?? "http://localhost:3000",
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// -------------------------------------------------------------------------
// Cookie auth — protect all routes except /health and /auth/*
// -------------------------------------------------------------------------
const cookieAuth: MiddlewareHandler = async (c, next) => {
  const token = getCookie(c, "fovet_token");
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

// -------------------------------------------------------------------------
// In-memory rate limiter — /auth/token: max 5 attempts per 15 min per IP
// -------------------------------------------------------------------------
export const loginBucket = new Map<string, { count: number; expiresAt: number }>();

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX_ATTEMPTS = 5;

  if (loginBucket.size > 500) {
    for (const [k, v] of loginBucket) {
      if (now > v.expiresAt) loginBucket.delete(k);
    }
  }

  const entry = loginBucket.get(ip);
  if (!entry || now > entry.expiresAt) {
    loginBucket.set(ip, { count: 1, expiresAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}

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

  if (!checkLoginRateLimit(ip)) {
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

  const token = await sign(
    { role: "dashboard", exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 },
    jwtSecret,
    "HS256"
  );
  setCookie(c, "fovet_token", token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return c.json({ ok: true });
});

// -------------------------------------------------------------------------
// POST /api/auth/logout — clear the auth cookie
// -------------------------------------------------------------------------
app.post("/auth/logout", (c) => {
  deleteCookie(c, "fovet_token", { path: "/" });
  return c.json({ ok: true });
});

// -------------------------------------------------------------------------
// GET /api/devices — list all active devices
// -------------------------------------------------------------------------
app.get("/devices", async (c) => {
  const devices = await prisma.device.findMany({
    where: { active: true },
    orderBy: { createdAt: "desc" },
  });
  return c.json(devices);
});

// -------------------------------------------------------------------------
// POST /api/devices — register a new device
// -------------------------------------------------------------------------
app.post("/devices", async (c) => {
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
app.get("/devices/:id/readings", async (c) => {
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
      await stream.writeSSE({ event: "reading", data: JSON.stringify(reading) });
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
// GET /api/devices/:id/alerts — unacknowledged alerts for a device
// -------------------------------------------------------------------------
app.get("/devices/:id/alerts", async (c) => {
  const { id } = c.req.param();

  const device = await prisma.device.findUnique({ where: { id }, select: { id: true } });
  if (!device) return c.json({ error: "Device not found" }, 404);

  const alerts = await prisma.alert.findMany({
    where: { deviceId: id, acknowledged: false },
    orderBy: { timestamp: "desc" },
    take: 50,
  });
  return c.json(alerts);
});

// -------------------------------------------------------------------------
// PATCH /api/alerts/:id/ack — acknowledge an alert
// -------------------------------------------------------------------------
app.patch("/alerts/:id/ack", async (c) => {
  const { id } = c.req.param();
  const existing = await prisma.alert.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return c.json({ error: "Alert not found" }, 404);

  const alert = await prisma.alert.update({
    where: { id },
    data: { acknowledged: true, acknowledgedAt: new Date() },
  });
  return c.json(alert);
});
