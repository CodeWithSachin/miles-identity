import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import type { Server } from "bun";
import { healthResponse, readyHandler } from "@/routes/health";
import { resetReadinessCache } from "@/services/health";
import { AppError, errorResponse } from "@/lib/errors";

/**
 * Point the datastore URLs at an unroutable port so readiness is deterministically
 * degraded without needing Postgres or Redis. This is the real ping path, not a mock.
 */
function makeDependenciesUnavailable(): void {
  Bun.env["DATABASE_URL"] = "postgres://nobody@127.0.0.1:1/none";
  Bun.env["REDIS_URL"] = "redis://127.0.0.1:1";
}

class ExposedError extends AppError {
  readonly code = "TEAPOT";
  readonly httpStatus = 418;
  override readonly expose = true;
}

/** The same route table as src/index.ts, plus a route that throws. */
function startTestServer(): Server<undefined> {
  return Bun.serve({
    port: 0,
    routes: {
      "/health": healthResponse,
      "/ready": { GET: readyHandler },
      "/boom": (): Response => {
        throw new Error("internal detail at /Users/secret/path/file.ts:42");
      },
    },
    fetch: (): Response => new Response("Not Found", { status: 404 }),
    error: (error: Error): Response => errorResponse(error),
  });
}

let server: Server<undefined> | undefined;

function testServer(): Server<undefined> {
  server ??= startTestServer();
  return server;
}

// This suite deliberately breaks DATABASE_URL and REDIS_URL. Restore them, or the
// database suites inherit an unroutable port and fail for reasons that have
// nothing to do with what they assert.
const originalDatabaseUrl = Bun.env["DATABASE_URL"];
const originalRedisUrl = Bun.env["REDIS_URL"];

beforeEach(() => {
  resetReadinessCache();
  makeDependenciesUnavailable();
});

afterAll(async () => {
  if (server !== undefined) await server.stop(true);

  if (originalDatabaseUrl === undefined) delete Bun.env["DATABASE_URL"];
  else Bun.env["DATABASE_URL"] = originalDatabaseUrl;

  if (originalRedisUrl === undefined) delete Bun.env["REDIS_URL"];
  else Bun.env["REDIS_URL"] = originalRedisUrl;
});

describe("/health — liveness", () => {
  test("returns 200 ok", async () => {
    const response = healthResponse.clone();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  // SECURITY / operability: liveness must survive a dead database, or an
  // orchestrator will kill healthy processes and turn a degradation into an outage.
  test("returns 200 with Postgres and Redis unavailable", async () => {
    const response = await fetch(`http://localhost:${testServer().port}/health`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("is not cached by intermediaries", () => {
    expect(healthResponse.headers.get("cache-control")).toBe("no-store");
  });
});

describe("/ready — readiness", () => {
  test("returns 503 when dependencies are down", async () => {
    const response = await fetch(`http://localhost:${testServer().port}/ready`);
    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("degraded");
    expect(body["postgres"]).toBe(false);
    expect(body["redis"]).toBe(false);
  });

  // SECURITY: the body of an unauthenticated endpoint is public. It must carry
  // booleans, never connection details.
  test("body contains no connection details", async () => {
    const raw = await (await fetch(`http://localhost:${testServer().port}/ready`)).text();

    expect(raw).not.toContain("postgres://");
    expect(raw).not.toContain("redis://");
    expect(raw).not.toContain("127.0.0.1");
    expect(raw).not.toContain("nobody");
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(["postgres", "redis", "status"]);
  });

  test("returns only the three expected fields", async () => {
    const readiness = await readyHandler();
    const body = (await readiness.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["postgres", "redis", "status"]);
  });
});

describe("error handling", () => {
  // SECURITY: an internal error must not disclose a stack trace or a file path.
  test("returns no stack trace or file path", async () => {
    const response = await fetch(`http://localhost:${testServer().port}/boom`);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toBe("Internal Server Error");
    expect(body).not.toContain("/Users/");
    expect(body).not.toContain(".ts");
    expect(body).not.toContain("internal detail");
  });

  test("collapses an unknown error to a generic 500", async () => {
    const response = errorResponse(new Error("secret internals"));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });

  test("honours expose:true and the error's own status", async () => {
    const response = errorResponse(new ExposedError("safe to show"));
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("safe to show");
  });

  test("collapses a non-Error throw", async () => {
    const response = errorResponse("a bare string");
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });
});

describe("unmatched routes", () => {
  test("returns 404", async () => {
    const response = await fetch(`http://localhost:${testServer().port}/does-not-exist`);
    expect(response.status).toBe(404);
  });
});
