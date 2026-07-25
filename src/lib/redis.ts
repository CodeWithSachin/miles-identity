/**
 * Redis via `Bun.redis`. Automatic reconnect with exponential backoff, command
 * pipelining, offline queue — all native. No ioredis.
 *
 * The default client reads REDIS_URL from the environment.
 *
 * Step 1 scope: connectivity only. Session secondary storage arrives in step 3.
 */

import { redis, RedisClient } from "bun";
import { log } from "./logger";

export { redis };

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * `PING` with a timeout. Never throws — same contract as pingPostgres.
 *
 * Probes a short-lived client bound to the CURRENT `REDIS_URL`, not the shared
 * `redis` client. Readiness must answer "is the configured Redis reachable right
 * now"; Bun's shared client resolves `REDIS_URL` once when it is first constructed
 * and never re-resolves it, so a probe through it reports a stale connection rather
 * than live reachability — and cannot report "down" at all once it has connected.
 * This mirrors `pingPostgres`, whose `Bun.sql` client does resolve the current
 * `DATABASE_URL`. Reading the datastore URL here is the same environment Bun's own
 * clients read implicitly — it is not application config, which lives in config.ts.
 *
 * The probe client fails fast (no reconnect, no retries, no offline queue) and is
 * closed on every path, so a probe never leaks a socket.
 */
export async function pingRedis(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  const client = new RedisClient(Bun.env["REDIS_URL"], {
    connectionTimeout: timeoutMs,
    autoReconnect: false,
    maxRetries: 0,
    enableOfflineQueue: false,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`redis ping exceeded ${timeoutMs}ms`)), timeoutMs);
    });

    const reply = await Promise.race([client.send("PING", []), timeout]);
    return typeof reply === "string" ? reply.toUpperCase() === "PONG" : reply !== null;
  } catch (error) {
    log.warn("redis_ping_failed", { reason: error instanceof Error ? error.name : "unknown" });
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    client.close();
  }
}

/** Close the connection on shutdown so a rolling deploy does not leak sockets. */
export function closeRedis(): void {
  try {
    redis.close();
  } catch (error) {
    log.warn("redis_close_failed", { reason: error instanceof Error ? error.name : "unknown" });
  }
}
