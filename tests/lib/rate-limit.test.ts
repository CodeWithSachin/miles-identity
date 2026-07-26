import { test, expect, describe, afterAll } from "bun:test";
import { RedisClient } from "bun";
import { checkRateLimit } from "@/lib/rate-limit";

const REDIS_URL = Bun.env["TEST_REDIS_URL"] ?? Bun.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
const client = new RedisClient(REDIS_URL);

/** Fresh key per test so buckets never collide across tests or re-runs. */
function key(): string {
  return `test:rl:${Bun.randomUUIDv7()}`;
}

afterAll(() => {
  client.close();
});

describe("checkRateLimit", () => {
  test("allows up to the limit, then blocks with a retry-after", async () => {
    const k = key();
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await checkRateLimit(k, 3, 60, client));

    expect(results.slice(0, 3).every((r) => r.allowed)).toBe(true);
    expect(results[3]?.allowed).toBe(false);
    expect(results[4]?.allowed).toBe(false);
    expect((results[3]?.retryAfterSeconds ?? 0) > 0).toBe(true);
  });

  test("resets after the window expires", async () => {
    const k = key();
    expect((await checkRateLimit(k, 1, 1, client)).allowed).toBe(true);
    expect((await checkRateLimit(k, 1, 1, client)).allowed).toBe(false);
    await Bun.sleep(1100);
    expect((await checkRateLimit(k, 1, 1, client)).allowed).toBe(true);
  });

  // A Redis outage already degrades the estate; failing closed would turn a blip
  // into an estate-wide login outage. So the limiter fails OPEN.
  test("fails OPEN when Redis is unreachable", async () => {
    const dead = new RedisClient("redis://127.0.0.1:1", {
      autoReconnect: false,
      maxRetries: 0,
      enableOfflineQueue: false,
      connectionTimeout: 500,
    });
    try {
      const result = await checkRateLimit(key(), 1, 60, dead);
      expect(result.allowed).toBe(true);
      expect(result.retryAfterSeconds).toBe(0);
    } finally {
      dead.close();
    }
  });
});
