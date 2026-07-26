/**
 * Fixed-window rate limiting over `Bun.redis`. Used to blunt the /resolve
 * enumeration oracle (security.md: rate limit per IP AND per handle).
 *
 * ponytail: fixed window is the simplest thing that holds. Its known ceiling is
 * a 2x burst across a window boundary; swap for a sliding window only if that
 * burst is shown to matter.
 */

import { redis } from "bun";
import type { RedisClient } from "bun";
import { log } from "./logger";

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

/**
 * Increment the window counter for `key` and decide if the caller is under
 * `limit`. `client` is injectable for tests.
 *
 * Fails OPEN on a Redis error: a Redis outage already degrades the whole estate
 * (sessions live there), so failing closed would turn a Redis blip into an
 * estate-wide login outage, while the enumeration window during that outage is
 * bounded by the outage itself. The warning is also the "alert on scan patterns"
 * signal. The key embeds a hashed handle, so it is never logged.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  client: RedisClient = redis,
): Promise<RateLimitResult> {
  try {
    const count = await client.incr(key);
    if (count === 1) await client.expire(key, windowSeconds);
    if (count <= limit) return { allowed: true, retryAfterSeconds: 0 };
    const ttl = await client.ttl(key);
    return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
  } catch (error) {
    log.warn("rate_limit_unavailable", { reason: error instanceof Error ? error.name : "unknown" });
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
