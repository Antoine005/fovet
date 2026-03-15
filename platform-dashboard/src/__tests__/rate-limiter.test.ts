/*
 * Tests for rate-limiter — both in-memory and Redis paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkRateLimit,
  loginBucket,
  _setRedisClient,
  MAX_ATTEMPTS,
  WINDOW_SEC,
} from "@/lib/rate-limiter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRedis(incrValue = 1) {
  return {
    incr: vi.fn().mockResolvedValue(incrValue),
    expire: vi.fn().mockResolvedValue(1),
  };
}

beforeEach(() => {
  // Reset to in-memory fallback before each test
  _setRedisClient(null);
  loginBucket.clear();
});

// ---------------------------------------------------------------------------
// In-memory fallback (no Redis)
// ---------------------------------------------------------------------------

describe("in-memory fallback (no REDIS_URL)", () => {
  it("allows the first request", async () => {
    expect(await checkRateLimit("1.2.3.4")).toBe(true);
  });

  it(`allows up to ${MAX_ATTEMPTS} attempts`, async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(await checkRateLimit("1.2.3.4")).toBe(true);
    }
  });

  it(`blocks the ${MAX_ATTEMPTS + 1}th attempt`, async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await checkRateLimit("1.2.3.4");
    }
    expect(await checkRateLimit("1.2.3.4")).toBe(false);
  });

  it("tracks different IPs independently", async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await checkRateLimit("10.0.0.1");
    }
    // Different IP should still be allowed
    expect(await checkRateLimit("10.0.0.2")).toBe(true);
  });

  it("resets after window expiry", async () => {
    // Exhaust limit
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await checkRateLimit("1.2.3.4");
    }
    expect(await checkRateLimit("1.2.3.4")).toBe(false);

    // Manually expire the window
    const entry = loginBucket.get("1.2.3.4");
    if (entry) entry.expiresAt = Date.now() - 1;

    expect(await checkRateLimit("1.2.3.4")).toBe(true);
  });

  it("populates loginBucket", async () => {
    await checkRateLimit("1.2.3.4");
    expect(loginBucket.has("1.2.3.4")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Redis path
// ---------------------------------------------------------------------------

describe("Redis path", () => {
  it("calls incr on the correct key", async () => {
    const redis = makeRedis(1);
    _setRedisClient(redis);

    await checkRateLimit("1.2.3.4");
    expect(redis.incr).toHaveBeenCalledWith("rl:auth:1.2.3.4");
  });

  it("calls expire on the first increment only", async () => {
    const redis = makeRedis(1);
    _setRedisClient(redis);

    await checkRateLimit("1.2.3.4");
    expect(redis.expire).toHaveBeenCalledWith("rl:auth:1.2.3.4", WINDOW_SEC);
  });

  it("does NOT call expire when count > 1", async () => {
    const redis = makeRedis(2);
    _setRedisClient(redis);

    await checkRateLimit("1.2.3.4");
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it("allows request when count <= MAX_ATTEMPTS", async () => {
    const redis = makeRedis(MAX_ATTEMPTS);
    _setRedisClient(redis);

    expect(await checkRateLimit("1.2.3.4")).toBe(true);
  });

  it("blocks request when count > MAX_ATTEMPTS", async () => {
    const redis = makeRedis(MAX_ATTEMPTS + 1);
    _setRedisClient(redis);

    expect(await checkRateLimit("1.2.3.4")).toBe(false);
  });

  it("fails open when Redis throws (incr error)", async () => {
    const redis = {
      incr: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      expire: vi.fn(),
    };
    _setRedisClient(redis);

    expect(await checkRateLimit("1.2.3.4")).toBe(true);
  });

  it("does not touch loginBucket when Redis is active", async () => {
    const redis = makeRedis(1);
    _setRedisClient(redis);

    await checkRateLimit("1.2.3.4");
    expect(loginBucket.size).toBe(0);
  });
});
