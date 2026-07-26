/**
 * Scalar spec + production-gating for the routes we own. See src/routes/docs.ts
 * and .agents/skills/scalar-api-docs.md.
 */

import { test, expect, describe } from "bun:test";
import { buildOpenApiSpec, docsRoutes } from "@/routes/docs";

describe("buildOpenApiSpec", () => {
  const spec = buildOpenApiSpec() as { paths: Record<string, unknown> };

  test("documents exactly the three routes we own", () => {
    expect(Object.keys(spec.paths).sort()).toEqual(["/api/identity/resolve", "/health", "/ready"]);
  });

  // Security rule 13 / skill rule 2: never document a route we don't own.
  test("never documents /api/internal/*", () => {
    expect(JSON.stringify(spec).includes("/api/internal")).toBe(false);
  });

  // Security rule 2 / skill rule 4: enumeration-safe means ONE response shape,
  // never a documented hit/miss distinction.
  test("documents exactly one 2xx response for /api/identity/resolve", () => {
    const responses = (spec.paths["/api/identity/resolve"] as any).post.responses;
    const twoXx = Object.keys(responses).filter((code) => code.startsWith("2"));
    expect(twoXx).toEqual(["200"]);
  });

  test("is valid JSON", () => {
    expect(() => JSON.parse(JSON.stringify(spec))).not.toThrow();
  });
});

describe("docsRoutes", () => {
  // AGENTS.md security rule 13: never publicly reachable in production — the
  // simplest, recommended posture, so the routes must not exist at all.
  test("is empty in production", () => {
    expect(docsRoutes("production")).toEqual({});
  });

  test("serves the reference and spec outside production", () => {
    expect(Object.keys(docsRoutes("development")).sort()).toEqual(["/api/docs", "/api/docs/openapi.json"]);
    expect(Object.keys(docsRoutes("test")).sort()).toEqual(["/api/docs", "/api/docs/openapi.json"]);
  });
});
