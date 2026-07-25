/**
 * Entry point. Routes only — no business logic (AGENTS.md, architecture rules).
 *
 * Step 1 mounts liveness and readiness. Step 3 adds the Better Auth catch-all at
 * `/api/auth/*` (sign-up, sign-in, sessions). Identity routes arrive in step 4.
 */

import { loadConfigOrExit, redactedSummary } from "@/lib/config";
import { log } from "@/lib/logger";
import { errorResponse } from "@/lib/errors";
import { closeRedis } from "@/lib/redis";
import { healthResponse, readyHandler } from "@/routes/health";
import { auth } from "@/auth";

// Fails fast and exits 1 on invalid configuration, before a port is bound.
const config = loadConfigOrExit();

const server = Bun.serve({
  port: config.PORT,

  routes: {
    "/health": healthResponse,
    "/ready": { GET: readyHandler },

    // Better Auth owns everything under /api/auth. No handler of ours goes inside
    // this prefix (AGENTS.md API contracts). More-specific routes above still win.
    "/api/auth/*": (req) => auth.handler(req),
  },

  // Unmatched paths.
  fetch(): Response {
    return new Response("Not Found", { status: 404 });
  },

  /**
   * Log the real error server-side; return a generic body.
   * Never a stack trace, never a file path, and never `error.message` unless the
   * error explicitly opted in via `expose`.
   */
  error(error: Error): Response {
    log.error("unhandled_request_error", error);
    return errorResponse(error);
  },
});

log.info("server_started", redactedSummary());

// ── graceful shutdown ─────────────────────────────────────────────────────────
// A rolling deploy must not drop live requests.

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info("shutdown_started", { signal });
  await server.stop(); // drains in-flight requests
  closeRedis();
  log.info("shutdown_complete", { signal });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// A rejected promise must be logged, not silently swallowed.
process.on("unhandledRejection", reason => {
  log.error("unhandled_rejection", reason);
});
