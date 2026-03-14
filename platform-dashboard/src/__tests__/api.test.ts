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
      findUnique: vi.fn(),
    },
    alert: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

// event-bus is a no-op in unit tests
vi.mock("@/lib/event-bus", () => ({
  emitReading: vi.fn(),
  subscribeToReadings: vi.fn(() => () => undefined),
}));

import { app, loginBucket } from "@/lib/api";
import { prisma } from "@/lib/prisma";

const SECRET = process.env.JWT_SECRET!;

async function cookieToken() {
  const token = await sign(
    { role: "dashboard", exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET,
    "HS256"
  );
  return `fovet_token=${token}`;
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
  it("returns 200 and sets httpOnly cookie on valid password", async () => {
    const res = await app.request("/api/auth/token", json({ password: "test-password" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toContain("fovet_token=");
    expect(cookie).toContain("HttpOnly");
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
      headers: { Cookie: await cookieToken() },
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
        Cookie: await cookieToken(),
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
        Cookie: await cookieToken(),
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
      headers: { Cookie: await cookieToken() },
    });
    expect(res.status).toBe(404);
  });

  it("returns envelope with data in chronological order", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue({ id: "d1" } as never);
    // DB returns desc order (most recent first), API reverses to asc
    const readings = [
      { id: BigInt(2), timestamp: "2026-01-01T00:00:02Z", value: 2 },
      { id: BigInt(1), timestamp: "2026-01-01T00:00:01Z", value: 1 },
    ];
    vi.mocked(prisma.reading.findMany).mockResolvedValue(readings as never);

    const res = await app.request("/api/devices/d1/readings", {
      headers: { Cookie: await cookieToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    // IDs serialized as strings
    expect(body.data[0].id).toBe("1");
    expect(body.data[1].id).toBe("2");
  });

  it("returns hasMore false when results <= limit", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue({ id: "d1" } as never);
    // 2 rows returned, limit defaults to 100 — no next page
    vi.mocked(prisma.reading.findMany).mockResolvedValue([
      { id: BigInt(2), timestamp: "2026-01-01T00:00:02Z", value: 2 },
      { id: BigInt(1), timestamp: "2026-01-01T00:00:01Z", value: 1 },
    ] as never);

    const res = await app.request("/api/devices/d1/readings", {
      headers: { Cookie: await cookieToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.hasMore).toBe(false);
    expect(body.pagination.nextCursor).toBeNull();
  });

  it("returns hasMore true and nextCursor when more rows exist", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue({ id: "d1" } as never);
    // limit=2, DB returns limit+1=3 rows → hasMore
    const threeRows = [
      { id: BigInt(3), timestamp: "2026-01-01T00:00:03Z", value: 3 },
      { id: BigInt(2), timestamp: "2026-01-01T00:00:02Z", value: 2 },
      { id: BigInt(1), timestamp: "2026-01-01T00:00:01Z", value: 1 },
    ];
    vi.mocked(prisma.reading.findMany).mockResolvedValue(threeRows as never);

    const res = await app.request("/api/devices/d1/readings?limit=2", {
      headers: { Cookie: await cookieToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.hasMore).toBe(true);
    // nextCursor = id of last item in the returned page (desc order, so id=2 after slice)
    expect(body.pagination.nextCursor).toBe("2");
    expect(body.data).toHaveLength(2);
  });

  it("returns 400 when cursor reading not found", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue({ id: "d1" } as never);
    vi.mocked(prisma.reading.findUnique).mockResolvedValue(null);

    const res = await app.request("/api/devices/d1/readings?cursor=999", {
      headers: { Cookie: await cookieToken() },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Cursor not found");
  });

  it("returns 400 on non-numeric cursor", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue({ id: "d1" } as never);

    const res = await app.request("/api/devices/d1/readings?cursor=bad", {
      headers: { Cookie: await cookieToken() },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid cursor");
  });
});

// ---------------------------------------------------------------------------
// GET /api/devices/:id/alerts
// ---------------------------------------------------------------------------
describe("GET /api/devices/:id/alerts", () => {
  it("returns 404 when device not found", async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue(null);

    const res = await app.request("/api/devices/unknown-id/alerts", {
      headers: { Cookie: await cookieToken() },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
describe("POST /api/auth/logout", () => {
  it("clears the cookie and returns 200", async () => {
    const res = await app.request("/api/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toContain("fovet_token=");
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
      headers: { Cookie: await cookieToken() },
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 and acknowledged alert", async () => {
    vi.mocked(prisma.alert.findUnique).mockResolvedValue({ id: "a1" } as never);
    const acked = { id: "a1", acknowledged: true, acknowledgedAt: new Date().toISOString() };
    vi.mocked(prisma.alert.update).mockResolvedValue(acked as never);

    const res = await app.request("/api/alerts/a1/ack", {
      method: "PATCH",
      headers: { Cookie: await cookieToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.acknowledged).toBe(true);
  });
});
