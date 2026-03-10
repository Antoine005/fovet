/*
 * Fovet Vigie — API route tests
 * Uses Hono's app.request() test helper — no HTTP server needed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sign } from "hono/jwt";

// Mock Prisma before importing the app
vi.mock("@/lib/prisma", () => ({
  prisma: {
    device: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    reading: {
      findMany: vi.fn(),
    },
    alert: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { app, loginBucket } from "@/lib/api";
import { prisma } from "@/lib/prisma";

const SECRET = process.env.JWT_SECRET!;

async function bearerToken() {
  const token = await sign(
    { role: "dashboard", exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET,
    "HS256"
  );
  return `Bearer ${token}`;
}

function json(body: unknown, extra?: RequestInit) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...extra,
  };
}

beforeEach(() => {
  loginBucket.clear();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------
describe("GET /api/health", () => {
  it("returns 200 with status ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", service: "fovet-vigie" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/token
// ---------------------------------------------------------------------------
describe("POST /api/auth/token", () => {
  it("returns 200 and token on valid password", async () => {
    const res = await app.request("/api/auth/token", json({ password: "test-password" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.split(".")).toHaveLength(3); // JWT format
  });

  it("returns 401 on wrong password", async () => {
    const res = await app.request("/api/auth/token", json({ password: "wrong" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 on missing password field", async () => {
    const res = await app.request("/api/auth/token", json({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await app.request("/api/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 429 after 5 failed attempts from same IP", async () => {
    const headers = {
      "Content-Type": "application/json",
      "x-forwarded-for": "10.0.0.1",
    };
    for (let i = 0; i < 5; i++) {
      await app.request("/api/auth/token", {
        method: "POST",
        headers,
        body: JSON.stringify({ password: "wrong" }),
      });
    }
    const res = await app.request("/api/auth/token", {
      method: "POST",
      headers,
      body: JSON.stringify({ password: "test-password" }),
    });
    expect(res.status).toBe(429);
  });

  it("does not rate-limit different IPs independently", async () => {
    for (let i = 0; i < 5; i++) {
      await app.request("/api/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "10.0.0.2" },
        body: JSON.stringify({ password: "wrong" }),
      });
    }
    // Different IP should still work
    const res = await app.request("/api/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "10.0.0.3" },
      body: JSON.stringify({ password: "test-password" }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/devices — requires JWT
// ---------------------------------------------------------------------------
describe("GET /api/devices", () => {
  it("returns 401 without token", async () => {
    const res = await app.request("/api/devices");
    expect(res.status).toBe(401);
  });

  it("returns 200 with device list", async () => {
    const mockDevices = [{ id: "d1", name: "ESP32", mqttClientId: "esp32-001", active: true }];
    vi.mocked(prisma.device.findMany).mockResolvedValue(mockDevices as never);

    const res = await app.request("/api/devices", {
      headers: { Authorization: await bearerToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(mockDevices);
  });
});

// ---------------------------------------------------------------------------
// POST /api/devices — requires JWT
// ---------------------------------------------------------------------------
describe("POST /api/devices", () => {
  it("returns 401 without token", async () => {
    const res = await app.request("/api/devices", json({ name: "x", mqttClientId: "y" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 on Zod validation error", async () => {
    const res = await app.request("/api/devices", {
      ...json({ name: "", mqttClientId: "y" }), // name too short
      headers: {
        "Content-Type": "application/json",
        Authorization: await bearerToken(),
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid input");
    expect(body.details).toBeDefined();
  });

  it("returns 201 on valid input", async () => {
    const created = { id: "d1", name: "ESP32", mqttClientId: "esp32-001" };
    vi.mocked(prisma.device.create).mockResolvedValue(created as never);

    const res = await app.request("/api/devices", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await bearerToken(),
      },
      body: JSON.stringify({ name: "ESP32", mqttClientId: "esp32-001" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(created);
  });
});

// ---------------------------------------------------------------------------
// GET /api/devices/:id/readings
// ---------------------------------------------------------------------------
describe("GET /api/devices/:id/readings", () => {
  it("returns 404 when device not found", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue(null);

    const res = await app.request("/api/devices/unknown-id/readings", {
      headers: { Authorization: await bearerToken() },
    });
    expect(res.status).toBe(404);
  });

  it("returns readings in chronological order", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue({ id: "d1" } as never);
    const readings = [
      { id: 2, timestamp: "2026-01-01T00:00:02Z", value: 2 },
      { id: 1, timestamp: "2026-01-01T00:00:01Z", value: 1 },
    ];
    vi.mocked(prisma.reading.findMany).mockResolvedValue(readings as never);

    const res = await app.request("/api/devices/d1/readings", {
      headers: { Authorization: await bearerToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // reversed from desc → asc
    expect(body[0].id).toBe(1);
    expect(body[1].id).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/devices/:id/alerts
// ---------------------------------------------------------------------------
describe("GET /api/devices/:id/alerts", () => {
  it("returns 404 when device not found", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue(null);

    const res = await app.request("/api/devices/unknown-id/alerts", {
      headers: { Authorization: await bearerToken() },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/alerts/:id/ack
// ---------------------------------------------------------------------------
describe("PATCH /api/alerts/:id/ack", () => {
  it("returns 401 without token", async () => {
    const res = await app.request("/api/alerts/abc/ack", { method: "PATCH" });
    expect(res.status).toBe(401);
  });

  it("returns 404 when alert not found", async () => {
    vi.mocked(prisma.alert.findUnique).mockResolvedValue(null);

    const res = await app.request("/api/alerts/unknown-id/ack", {
      method: "PATCH",
      headers: { Authorization: await bearerToken() },
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 and acknowledged alert", async () => {
    vi.mocked(prisma.alert.findUnique).mockResolvedValue({ id: "a1" } as never);
    const acked = { id: "a1", acknowledged: true, acknowledgedAt: new Date().toISOString() };
    vi.mocked(prisma.alert.update).mockResolvedValue(acked as never);

    const res = await app.request("/api/alerts/a1/ack", {
      method: "PATCH",
      headers: { Authorization: await bearerToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.acknowledged).toBe(true);
  });
});
