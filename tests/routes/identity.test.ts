import { test, expect, describe, beforeAll, afterAll, spyOn } from "bun:test";
import type { Server } from "bun";
import { RedisClient } from "bun";
import { resolveRoute } from "@/routes/identity";

const REDIS_URL = Bun.env["TEST_REDIS_URL"] ?? Bun.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
const rateClient = new RedisClient(REDIS_URL);

let server: Server<undefined>;

beforeAll(async () => {
  // Reset the per-IP bucket so re-runs inside the window start from zero; each
  // test otherwise uses a unique handle, so only the shared IP bucket persists.
  await Promise.all(
    ["127.0.0.1", "::1", "::ffff:127.0.0.1", "unknown"].map((a) =>
      rateClient.del(`rl:resolve:ip:${a}`).catch(() => 0),
    ),
  );

  server = Bun.serve({
    port: 0,
    routes: {
      "/api/identity/resolve": { POST: (req, s) => resolveRoute(req, s, rateClient) },
    },
    fetch: (): Response => new Response("Not Found", { status: 404 }),
  });
});

afterAll(async () => {
  await server.stop(true);
  rateClient.close();
});

function post(handle: unknown): Promise<Response> {
  return fetch(`http://localhost:${server.port}/api/identity/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  });
}

function uniqueHandle(): string {
  return `u${Bun.randomUUIDv7().replace(/-/g, "").slice(0, 12)}@example.com`;
}

describe("POST /api/identity/resolve", () => {
  test("returns 200 {methods} and is not cached", async () => {
    const res = await post(uniqueHandle());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ methods: ["password"] });
  });

  // SECURITY: the endpoint must not reveal whether a handle exists. The body is a
  // pure function of the handle, so any two handles yield byte-identical output —
  // an email, a phone, and an unclassifiable string are indistinguishable.
  test("returns byte-identical bodies for different handles (no enumeration oracle)", async () => {
    const [a, b, c] = await Promise.all([
      post(uniqueHandle()),
      post("9811100999"),
      post("nobody-unclassifiable"),
    ]);
    const [ba, bb, bc] = await Promise.all([a.text(), b.text(), c.text()]);
    expect(a.status).toBe(200);
    expect(ba).toBe(bb);
    expect(bb).toBe(bc);
  });

  // SECURITY: rate limit per handle so the endpoint cannot be scanned.
  test("rate-limits per handle after the limit", async () => {
    const handle = uniqueHandle();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(handle)).status);

    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);

    const last = await post(handle);
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("returns 400 for a non-JSON body", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/identity/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  test("returns 400 when the handle field is missing", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/identity/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notHandle: "x" }),
    });
    expect(res.status).toBe(400);
  });

  // SECURITY: the handle is PII (full email/phone) the logger's key-name denylist
  // does not catch. It must never appear in a log line — only the handle TYPE may.
  test("never writes the handle value to a log line", async () => {
    const handle = `secret-${Bun.randomUUIDv7()}@example.com`;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    let logged = "";
    try {
      await post(handle);
      // Read before mockRestore() — it resets mock.calls.
      logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    } finally {
      logSpy.mockRestore();
    }

    expect(logged).toContain("identity_resolve");
    expect(logged).not.toContain(handle);
  });
});
