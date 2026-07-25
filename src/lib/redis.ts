/**
 * Redis via `Bun.redis`. Automatic reconnect with exponential backoff, command
 * pipelining, offline queue — all native. No ioredis.
 *
 * The default client reads REDIS_URL from the environment.
 *
 * Step 1 scope: connectivity only. Session secondary storage arrives in step 3.
 */

import { redis } from "bun";
import { log } from "./logger";

export { redis };

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * `PING` with a timeout. Never throws — same contract as pingPostgres.
 *
 * Bun's client has no dedicated ping method, so this uses the raw command path.
 * PING is on the list of commands that bypass auto-pipelining, which is what we
 * want for a health probe: it measures the connection, not the queue.
 */
export async function pingRedis(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`redis ping exceeded ${timeoutMs}ms`)), timeoutMs);
    });

    const reply = await Promise.race([redis.send("PING", []), timeout]);
    return typeof reply === "string" ? reply.toUpperCase() === "PONG" : reply !== null;
  } catch (error) {
    log.warn("redis_ping_failed", { reason: error instanceof Error ? error.name : "unknown" });
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
