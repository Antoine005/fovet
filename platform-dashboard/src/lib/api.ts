/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { jwt, sign } from "hono/jwt";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

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
// JWT auth — protect all routes except /health and /auth/token
// -------------------------------------------------------------------------
app.use("/devices/*", jwt({ secret: jwtSecret, alg: "HS256" }));
app.use("/alerts/*", jwt({ secret: jwtSecret, alg: "HS256" }));

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
  return c.json({ token });
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
// GET /api/devices/:id/readings — last N readings for a device
// -------------------------------------------------------------------------
app.get("/devices/:id/readings", async (c) => {
  const { id } = c.req.param();
  const rawLimit = parseInt(c.req.query("limit") ?? "100", 10);
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100, 1000);

  const device = await prisma.device.findUnique({ where: { id }, select: { id: true } });
  if (!device) return c.json({ error: "Device not found" }, 404);

  const readings = await prisma.reading.findMany({
    where: { deviceId: id },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
  return c.json(readings.reverse());
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
