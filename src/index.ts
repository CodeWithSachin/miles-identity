/**
 * Entry point. Routes only — no business logic (AGENTS.md, architecture rules).
 *
 * Step 1 mounts liveness and readiness. Step 3 adds the Better Auth catch-all at
 * `/api/auth/*` (sign-up, sign-in, sessions). Step 4 adds `/api/identity/resolve`.
 */

import { loadConfigOrExit, redactedSummary } from "@/lib/config";
import { log } from "@/lib/logger";
import { errorResponse } from "@/lib/errors";
import { closeRedis } from "@/lib/redis";
import { healthResponse, readyHandler } from "@/routes/health";
import { resolveRoute } from "@/routes/identity";
import { adminAccessRoute } from "@/routes/admin/access";
import {
  createVendorRoute,
  disableVendorRoute,
  registerVendorSsoProviderRoute,
  verifyVendorDomainRoute,
} from "@/routes/admin/vendors";
import { provisionRoute } from "@/routes/internal/provision";
import { signInPage } from "@/routes/login";
import { docsRoutes } from "@/routes/docs";
import { auth } from "@/auth";

// Graph authorization (roadmap step 11): outbox drain + shadow-mode
// reconciliation. Side-effect imports only — each registers its own
// Bun.cron schedule and is never reachable from an HTTP request.
import "@/jobs/outbox-worker";
import "@/jobs/shadow-reconciliation";

// Fails fast and exits 1 on invalid configuration, before a port is bound.
const config = loadConfigOrExit();

const server = Bun.serve({
  port: config.PORT,

  routes: {
    // Never mounted in production at all — see src/routes/docs.ts and
    // .agents/skills/scalar-api-docs.md.
    ...docsRoutes(config.NODE_ENV),

    "/health": healthResponse,
    "/ready": { GET: readyHandler },

    // Hosted login page — the target of Better Auth's `loginPage: "/sign-in"`
    // (src/auth.ts). Masterclass-themed static page; see src/routes/login.ts.
    "/sign-in": signInPage,

    // The pre-login resolver. Enumeration-sensitive — see src/routes/identity.ts.
    "/api/identity/resolve": { POST: (req, server) => resolveRoute(req, server) },

    // Product access RBAC — grant/revoke. Session-authed, admin-only; the
    // authorization check lives in src/services/access.ts, not here.
    "/api/admin/access": { POST: (req) => adminAccessRoute(req) },

    // Vendor SSO lifecycle (roadmap step 11). Session-authed, ADMIN-for-
    // masterclass-only; the authorization check lives in
    // src/services/vendor-sso.ts, not here.
    "/api/admin/vendors": { POST: (req) => createVendorRoute(req) },
    "/api/admin/vendors/:vendorId/sso-provider": {
      POST: (req) => registerVendorSsoProviderRoute(req, req.params.vendorId),
    },
    "/api/admin/vendors/:vendorId/verify-domain": {
      POST: (req) => verifyVendorDomainRoute(req, req.params.vendorId),
    },
    "/api/admin/vendors/:vendorId/disable": {
      POST: (req) => disableVendorRoute(req, req.params.vendorId),
    },

    // Salesforce Lead-conversion callout (roadmap step 12). Network-allowlisted
    // and HMAC-signed, never session-authed and never documented — see
    // src/routes/internal/provision.ts.
    "/api/internal/provision": { POST: (req) => provisionRoute(req) },

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
