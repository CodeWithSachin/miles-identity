import { test, expect, describe } from "bun:test";
import { createReadinessChecker, type Probes } from "@/services/health";
import { pingPostgres } from "@/db/client";
import { pingRedis } from "@/lib/redis";

/** Counting probes, so "one pair of pings" is an assertion rather than a hope. */
function probes(postgres: boolean, redis: boolean, delayMs = 0) {
  const calls = { postgres: 0, redis: 0 };
  const impl: Probes = {
    postgres: async () => {
      calls.postgres++;
      if (delayMs > 0) await Bun.sleep(delayMs);
      return postgres;
    },
    redis: async () => {
      calls.redis++;
      if (delayMs > 0) await Bun.sleep(delayMs);
      return redis;
    },
  };
  return { impl, calls };
}

describe("createReadinessChecker", () => {
  test("reports ok when both dependencies respond", async () => {
    const { impl } = probes(true, true);
    const checker = createReadinessChecker(impl);

    expect(await checker.check()).toEqual({ status: "ok", postgres: true, redis: true });
  });

  // Negative — a dead database must surface as degraded, not as ok.
  test("reports degraded when Postgres fails", async () => {
    const { impl } = probes(false, true);
    const checker = createReadinessChecker(impl);

    expect(await checker.check()).toEqual({ status: "degraded", postgres: false, redis: true });
  });

  // Negative.
  test("reports degraded when Redis fails", async () => {
    const { impl } = probes(true, false);
    const checker = createReadinessChecker(impl);

    expect(await checker.check()).toEqual({ status: "degraded", postgres: true, redis: false });
  });

  test("reports degraded when both fail", async () => {
    const { impl } = probes(false, false);
    const checker = createReadinessChecker(impl);

    expect(await checker.check()).toEqual({ status: "degraded", postgres: false, redis: false });
  });

  test("probes both dependencies concurrently, not in sequence", async () => {
    const { impl } = probes(true, true, 60);
    const checker = createReadinessChecker(impl);

    const started = Date.now();
    await checker.check();
    // Sequential would be ~120ms. Allow generous headroom for slow CI.
    expect(Date.now() - started).toBeLessThan(110);
  });
});

describe("readiness caching", () => {
  test("caches within the window — a second call does not re-probe", async () => {
    const { impl, calls } = probes(true, true);
    const checker = createReadinessChecker(impl, 5000);

    await checker.check();
    await checker.check();

    expect(calls.postgres).toBe(1);
    expect(calls.redis).toBe(1);
  });

  test("re-probes once the window has elapsed", async () => {
    const { impl, calls } = probes(true, true);
    let clock = 1_000_000;
    const checker = createReadinessChecker(impl, 5000, () => clock);

    await checker.check();
    clock += 5001;
    await checker.check();

    expect(calls.postgres).toBe(2);
  });

  // SECURITY-adjacent: /ready is unauthenticated and hits two datastores.
  // Without a shared in-flight promise, N parallel requests cost N ping pairs.
  test("shares one in-flight promise under concurrency", async () => {
    const { impl, calls } = probes(true, true, 30);
    const checker = createReadinessChecker(impl, 5000);

    const results = await Promise.all(Array.from({ length: 10 }, () => checker.check()));

    expect(calls.postgres).toBe(1);
    expect(calls.redis).toBe(1);
    for (const result of results) expect(result.status).toBe("ok");
  });

  test("reset() clears the cache", async () => {
    const { impl, calls } = probes(true, true);
    const checker = createReadinessChecker(impl, 5000);

    await checker.check();
    checker.reset();
    await checker.check();

    expect(calls.postgres).toBe(2);
  });
});

describe("real probes", () => {
  // Negative — an unroutable port, so this asserts the real timeout path without
  // needing a datastore. A mocked client would not fail the way a socket does.
  test("pingPostgres returns false rather than throwing when unreachable", async () => {
    const original = Bun.env["DATABASE_URL"];
    Bun.env["DATABASE_URL"] = "postgres://nobody@127.0.0.1:1/none";
    try {
      expect(await pingPostgres(300)).toBe(false);
    } finally {
      if (original === undefined) delete Bun.env["DATABASE_URL"];
      else Bun.env["DATABASE_URL"] = original;
    }
  });

  test("pingRedis returns false rather than throwing when unreachable", async () => {
    const original = Bun.env["REDIS_URL"];
    Bun.env["REDIS_URL"] = "redis://127.0.0.1:1";
    try {
      expect(await pingRedis(300)).toBe(false);
    } finally {
      if (original === undefined) delete Bun.env["REDIS_URL"];
      else Bun.env["REDIS_URL"] = original;
    }
  });
});
