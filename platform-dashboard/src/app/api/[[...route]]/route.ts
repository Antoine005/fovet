import { Hono } from "hono";
import { handle } from "hono/vercel";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const app = new Hono().basePath("/api");

// -------------------------------------------------------------------------
// GET /api/health
// -------------------------------------------------------------------------
app.get("/health", (c) => c.json({ status: "ok", service: "fovet-vigie" }));

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
  const body = await c.req.json<{
    name: string;
    mqttClientId: string;
    description?: string;
    location?: string;
  }>();

  if (!body.name || !body.mqttClientId) {
    return c.json({ error: "name and mqttClientId are required" }, 400);
  }
  if (
    typeof body.name !== "string" || body.name.length > 100 ||
    typeof body.mqttClientId !== "string" || body.mqttClientId.length > 100 ||
    (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 500)) ||
    (body.location !== undefined && (typeof body.location !== "string" || body.location.length > 200))
  ) {
    return c.json({ error: "Invalid input: check field types and lengths" }, 400);
  }

  const device = await prisma.device.create({
    data: {
      name: body.name,
      mqttClientId: body.mqttClientId,
      description: body.description,
      location: body.location,
    },
  });
  return c.json(device, 201);
});

// -------------------------------------------------------------------------
// GET /api/devices/:id/readings — last N readings for a device
// -------------------------------------------------------------------------
app.get("/devices/:id/readings", async (c) => {
  const { id } = c.req.param();
  const rawLimit = parseInt(c.req.query("limit") ?? "100", 10);
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100, 1000);

  const readings = await prisma.reading.findMany({
    where: { deviceId: id },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
  return c.json(readings.reverse()); // chronological order for charts
});

// -------------------------------------------------------------------------
// GET /api/devices/:id/alerts — unacknowledged alerts for a device
// -------------------------------------------------------------------------
app.get("/devices/:id/alerts", async (c) => {
  const { id } = c.req.param();

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
  const alert = await prisma.alert.update({
    where: { id },
    data: { acknowledged: true, acknowledgedAt: new Date() },
  });
  return c.json(alert);
});

export const GET = handle(app);
export const POST = handle(app);
export const PATCH = handle(app);
