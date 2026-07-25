/**
 * Liveness and readiness. Thin: parse, call a service, shape a response.
 *
 * The distinction matters operationally. `/health` says "this process is alive",
 * `/ready` says "it can serve traffic". If /health touched Postgres, a database
 * blip would make the orchestrator kill healthy processes — turning a degradation
 * into an outage.
 */

import { checkReadiness } from "@/services/health";

/**
 * Static Response: Bun.serve dispatches it with zero allocation and never calls
 * a handler, which also makes "touches no datastore" structurally true rather
 * than a promise in a comment.
 */
export const healthResponse = new Response("ok", {
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
});

/**
 * Booleans only. No error strings, no connection details, no hostnames — this
 * endpoint is unauthenticated, so its body is public.
 */
export async function readyHandler(): Promise<Response> {
  const readiness = await checkReadiness();

  return Response.json(readiness, {
    status: readiness.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
