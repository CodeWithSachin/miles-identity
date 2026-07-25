/**
 * Readiness logic. Takes and returns plain data — no Request, no Response — so
 * it is testable without HTTP (AGENTS.md, architecture rules).
 *
 * `/ready` is unauthenticated and touches two datastores, so an unthrottled load
 * balancer or a hostile client could use it to hammer Postgres. The result is
 * cached, and concurrent callers share one in-flight check, so N requests inside
 * the window cost one pair of pings rather than N.
 */

import { pingPostgres } from "@/db/client";
import { pingRedis } from "@/lib/redis";
import { log } from "@/lib/logger";

export type ReadinessStatus = "ok" | "degraded";

export type Readiness = {
  status: ReadinessStatus;
  postgres: boolean;
  redis: boolean;
};

export type Probes = {
  postgres: () => Promise<boolean>;
  redis: () => Promise<boolean>;
};

export const READINESS_CACHE_MS = 5000;

/**
 * Probes are injected so the caching and concurrency behaviour can be tested
 * deterministically, without standing up datastores to prove a timer works.
 * The real probes are exercised against real Postgres and Redis separately.
 */
export function createReadinessChecker(
  probes: Probes,
  cacheMs: number = READINESS_CACHE_MS,
  now: () => number = Date.now,
): { check: () => Promise<Readiness>; reset: () => void } {
  let cached: { at: number; value: Readiness } | undefined;
  let inFlight: Promise<Readiness> | undefined;

  async function run(): Promise<Readiness> {
    const [postgres, redis] = await Promise.all([probes.postgres(), probes.redis()]);
    const value: Readiness = {
      status: postgres && redis ? "ok" : "degraded",
      postgres,
      redis,
    };
    cached = { at: now(), value };
    // Logged here, not in the route: one line per actual probe rather than one per
    // request. /ready is unauthenticated, so per-request logging is a log-flood
    // vector, and a line that does not correspond to real work is noise anyway.
    log.info("readiness_check", value);
    return value;
  }

  return {
    async check(): Promise<Readiness> {
      if (cached !== undefined && now() - cached.at < cacheMs) return cached.value;
      // Share the in-flight promise so ten parallel probes cost one check.
      inFlight ??= run().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    reset(): void {
      cached = undefined;
      inFlight = undefined;
    },
  };
}

const defaultChecker = createReadinessChecker({ postgres: pingPostgres, redis: pingRedis });

export function checkReadiness(): Promise<Readiness> {
  return defaultChecker.check();
}

/** Test-only: clear the module-level cache between cases. */
export function resetReadinessCache(): void {
  defaultChecker.reset();
}
