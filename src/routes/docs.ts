/**
 * Scalar API documentation for the routes we own (AGENTS.md: routes/ = thin HTTP).
 * See .agents/skills/scalar-api-docs.md.
 *
 * Two spec sources, one page: Better Auth's own `openAPI()` plugin (src/auth.ts)
 * covers `/api/auth/*` — including alias-otp's `/sign-in/otp/start|verify`,
 * registered as ordinary plugin endpoints. This file covers everything else we
 * wrote: `/api/identity/resolve`, `/api/admin/access`, `/health`, `/ready`. The
 * spec is generated from the SAME zod schemas that validate requests/responses
 * at those boundaries (src/routes/identity.ts, src/routes/admin/access.ts) —
 * never a hand-written parallel spec.
 *
 * `/api/admin/access` is admin-only but NOT excluded like `/api/internal/*` — it
 * is reachable from the admin console over a session cookie, not network-
 * allowlisted, so it is documented like any other route we own.
 *
 * `docsRoutes` is a pure function of NODE_ENV so the production-exposure
 * guarantee (security rule 13 — never publicly reachable in production) is a
 * fast unit test, not only a manual curl check.
 */

import { z } from "zod";
import { bodySchema, responseSchema } from "@/routes/identity";
import { bodySchema as adminAccessBodySchema, responseSchema as adminAccessResponseSchema } from "@/routes/admin/access";

/** Mirrors src/services/health.ts's `Readiness` type. That boundary has no zod
 * schema of its own (no request body to validate), so this is docs-only. */
const readySchema = z.object({
  status: z.enum(["ok", "degraded"]),
  postgres: z.boolean(),
  redis: z.boolean(),
});

/**
 * Pure. Assembles the OpenAPI 3.1.1 document for our half of the API.
 * `/api/identity/resolve` documents exactly ONE 200 response — no hit/miss
 * distinction, matching the endpoint's enumeration-safe behaviour (security.md
 * rule 2). No `/api/internal/*` route is ever added here.
 */
export function buildOpenApiSpec(): object {
  return {
    openapi: "3.1.1",
    info: { title: "Miles Identity API", version: "1.0.0" },
    paths: {
      "/health": {
        get: {
          summary: "Liveness — this process is alive",
          responses: {
            "200": { description: "OK", content: { "text/plain": { schema: { type: "string" } } } },
          },
        },
      },
      "/ready": {
        get: {
          summary: "Readiness — can serve traffic",
          responses: {
            "200": { description: "Ready", content: { "application/json": { schema: z.toJSONSchema(readySchema) } } },
            "503": {
              description: "Degraded",
              content: { "application/json": { schema: z.toJSONSchema(readySchema) } },
            },
          },
        },
      },
      "/api/identity/resolve": {
        post: {
          summary: "Handle → sign-in methods, for the login screen",
          requestBody: {
            required: true,
            content: { "application/json": { schema: z.toJSONSchema(bodySchema) } },
          },
          responses: {
            "200": {
              description: "OK. Identical shape and timing for a hit, a miss and an unclassifiable handle.",
              content: { "application/json": { schema: z.toJSONSchema(responseSchema) } },
            },
            "400": { description: "Invalid request body" },
            "429": { description: "Rate limited (per IP and per handle)" },
          },
        },
      },
      "/api/admin/access": {
        post: {
          summary: "Grant or revoke a user's product access (admin only)",
          security: [{ session: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: z.toJSONSchema(adminAccessBodySchema) } },
          },
          responses: {
            "200": {
              description: "The resulting user_product_access row.",
              content: { "application/json": { schema: z.toJSONSchema(adminAccessResponseSchema) } },
            },
            "400": { description: "Invalid request body, or a role/vendor_id mismatch" },
            "401": { description: "No session" },
            "403": { description: "Session present, but not an ADMIN for this product_id" },
            "404": { description: "Target user not found, or no active row to revoke" },
          },
        },
      },
    },
  };
}

/** `Response.json` with a no-store header — a spec is never cached. */
export function openApiSpec(spec: object): Response {
  return Response.json(spec, { headers: { "cache-control": "no-store" } });
}

/** Static: dispatched by Bun.serve with zero allocation, matches the skill. */
export const scalarPage = new Response(
  `<!doctype html><html><head><title>Miles Identity API</title>
   <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
   <body><div id="app"></div>
   <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
   <script>
     Scalar.createApiReference('#app', {
       sources: [
         { url: '/api/docs/openapi.json', title: 'Identity API' },
         { url: '/api/auth/open-api/generate-schema', title: 'Auth' },
       ],
     })
   </script></body></html>`,
  { headers: { "content-type": "text/html; charset=utf-8" } },
);

/**
 * Pure. The reference and spec are never mounted in production at all — the
 * skill's simplest, recommended option, and the only one AGENTS.md rule 13
 * requires. `src/index.ts` spreads this straight into its route map.
 */
export function docsRoutes(
  nodeEnv: "development" | "test" | "production",
): Record<string, Response | { GET: () => Response }> {
  if (nodeEnv === "production") return {};
  return {
    "/api/docs": scalarPage,
    "/api/docs/openapi.json": { GET: () => openApiSpec(buildOpenApiSpec()) },
  };
}
