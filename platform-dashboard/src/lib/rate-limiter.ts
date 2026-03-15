/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

/**
 * Rate limiter for /api/auth/token — max 5 attempts per 15 min per IP.
 *
 * Strategy:
 *   - Redis (REDIS_URL set): atomic INCR + EXPIRE on key `rl:auth:<ip>`.
 *     Safe for multi-instance / multi-pod deployments.
 *   - In-memory fallback (no REDIS_URL): shared Map per Node.js process.
 *     Only suitable for single-instance development.
 *
 * Redis error handling: fail-open — if Redis is unreachable the request is
 * allowed through to avoid blocking legitimate users during an outage.
 *
 * Migration from in-memory to Redis:
 *   1. Add REDIS_URL to .env (see .env.example)
 *   2. Uncomment the redis service in docker-compose.yml
 *   3. Restart the dashboard container
 */

type RedisLike = {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
};

export const WINDOW_SEC   = 15 * 60;       // 15 minutes
export const WINDOW_MS    = WINDOW_SEC * 1000;
export const MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// In-memory fallback (single-instance / dev)
// ---------------------------------------------------------------------------

/**
 * In-memory bucket used when REDIS_URL is not set.
 * Exported for test cleanup: call `loginBucket.clear()` in beforeEach.
 */
export const loginBucket = new Map<string, { count: number; expiresAt: number }>();

// ---------------------------------------------------------------------------
// Redis client (lazy init, injectable for tests)
// ---------------------------------------------------------------------------

// undefined = not yet initialised | null = no Redis configured | RedisLike = ready
let _redis: RedisLike | null | undefined = undefined;

/**
 * Override the Redis client — for unit tests only.
 * Pass `null` to force the in-memory fallback.
 */
export function _setRedisClient(client: RedisLike | null): void {
  _redis = client;
}

function _getRedis(): RedisLike | null {
  if (_redis !== undefined) return _redis;

  const url = process.env.REDIS_URL;
  if (!url) {
    _redis = null;
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Redis } = require("ioredis") as { Redis: new (url: string, opts: object) => RedisLike & { on(event: string, cb: (e: Error) => void): void } };
    const client = new Redis(url, {
      lazyConnect: false,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    client.on("error", (err: Error) => {
      console.error("[rate-limiter] Redis error:", err.message);
    });
    _redis = client;
  } catch (err) {
    console.warn("[rate-limiter] ioredis unavailable, falling back to in-memory:", err);
    _redis = null;
  }

  return _redis;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether the IP is within its rate-limit window.
 *
 * @returns `true` if the request is allowed, `false` if the limit is exceeded.
 */
export async function checkRateLimit(ip: string): Promise<boolean> {
  const redis = _getRedis();

  // ── Redis path ────────────────────────────────────────────────────────────
  if (redis !== null) {
    const key = `rl:auth:${ip}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) {
        // Set TTL only on the first increment so the window is fixed from the
        // first attempt, not reset on every subsequent request.
        await redis.expire(key, WINDOW_SEC);
      }
      return count <= MAX_ATTEMPTS;
    } catch {
      // Redis unreachable → fail open
      return true;
    }
  }

  // ── In-memory fallback ────────────────────────────────────────────────────
  const now = Date.now();

  // Periodic cleanup to prevent unbounded Map growth
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
