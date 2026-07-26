/**
 * `aliasOtp` — the first-party Better Auth plugin that makes passwordless sign-in
 * respect the alias identity model. See .agents/skills/alias-identity.md.
 *
 * Better Auth's own `emailOTP`/`phoneNumber` plugins resolve a user by the single
 * `user.email` / `user.phoneNumber` column — they cannot see `user_identity`, so a
 * secondary verified handle (the whole point of the alias model) would fail to sign
 * in, or worse, auto-create a duplicate user. This plugin instead resolves the
 * TYPED handle through `resolveVerifiedUser` (verified-only, alias-aware) and mints
 * the session for the resolved GLOBAL `usr_` id, whichever handle was typed.
 *
 * This file is only the HTTP adapter (AGENTS.md: routes thin, logic in services/).
 * The flow lives in src/services/otp-signin.ts; here we map `ctx` → its injected
 * collaborators, rate-limit, and shape the response. Better Auth still provides OTP
 * storage (its Redis-backed `verification` table), the session store and cookies.
 *
 * The `bun`-touching modules (`@/identity/resolve` → `Bun.sql`, `@/lib/rate-limit`
 * → `Bun.redis`) are imported lazily inside the handlers, mirroring `getRedis` in
 * src/auth.ts: it keeps `auth.options` loadable by the schema tooling without a
 * live `bun` runtime, and the handlers only ever run under `Bun.serve`.
 */

import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";
import { normaliseHandle } from "@/identity/normalise";
import { startOtpSignin, verifyOtpSignin, type OtpStore, type Sender } from "@/services/otp-signin";
import { log } from "@/lib/logger";

export type AliasOtpOptions = {
  sendEmailOtp: Sender;
  sendSmsOtp: Sender;
  /** Set only when DEV_OTP_BYPASS is enabled (unrepresentable in production —
   * see src/lib/config.ts). Threaded straight into startOtpSignin's deps. */
  devOtp?: string | undefined;
};

// Mirrors the /resolve limiter (routes/identity.ts). Per-handle is the load-bearing
// enumeration control; per-IP is Better Auth's own rate limiter (plugin `rateLimit`
// below), best-effort until trusted-proxy IP extraction lands (roadmap step 15).
const HANDLE_LIMIT = 5;
const WINDOW_SECONDS = 60;
const IP_LIMIT = 30;

const startBody = z.object({ handle: z.string().min(1).max(320) });
const verifyBody = z.object({
  handle: z.string().min(1).max(320),
  otp: z.string().min(1).max(12),
});

/** One generic failure for every reject reason, so a bad handle and a bad/expired
 * code are indistinguishable — no existence disclosure on the verify path. */
function invalidOtp(): APIError {
  return new APIError("BAD_REQUEST", { code: "INVALID_OTP", message: "Invalid or expired code." });
}

/** Hashed rate-limit bucket, keyed on the NORMALISED handle so casing/whitespace
 * variants share one bucket. Exported for unit testing. */
export function handleBucket(parsed: { type: string; value: string } | null, raw: string): string {
  const material = parsed ? `${parsed.type}:${parsed.value}` : raw.trim().toLowerCase();
  return new Bun.CryptoHasher("sha256").update(material).digest("hex").slice(0, 32);
}

/** Adapt Better Auth's verification store to the service's `OtpStore` seam. */
export function verificationStore(internalAdapter: {
  createVerificationValue(data: { identifier: string; value: string; expiresAt: Date }): Promise<unknown>;
  findVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date } | null>;
  updateVerificationByIdentifier(identifier: string, data: { value: string }): Promise<unknown>;
  deleteVerificationByIdentifier(identifier: string): Promise<unknown>;
}): OtpStore {
  return {
    create: async (identifier, value, expiresAt) => {
      await internalAdapter.createVerificationValue({ identifier, value, expiresAt });
    },
    find: async (identifier) => {
      const record = await internalAdapter.findVerificationValue(identifier);
      return record ? { value: record.value, expiresAt: record.expiresAt } : null;
    },
    update: async (identifier, value) => {
      await internalAdapter.updateVerificationByIdentifier(identifier, { value });
    },
    delete: async (identifier) => {
      await internalAdapter.deleteVerificationByIdentifier(identifier);
    },
  };
}

export function aliasOtp(options: AliasOtpOptions) {
  return {
    id: "alias-otp",
    // Stored like Better Auth's own plugins (jwt, oauth-provider, open-api) do,
    // so wiring is inspectable the same way in tests/auth/instance.test.ts.
    options,
    endpoints: {
      /**
       * POST /api/auth/sign-in/otp/start — send a sign-in OTP to the typed handle.
       *
       * Enumeration-safe: returns the identical `{ ok: true }` for a hit, a miss and
       * an unclassifiable handle, and sends NOTHING on a miss. Rate limited per
       * handle. The session (issued by /verify) is for the resolved global user.
       */
      startAliasOtp: createAuthEndpoint(
        "/sign-in/otp/start",
        { method: "POST", body: startBody },
        async (ctx) => {
          ctx.setHeader("cache-control", "no-store");
          const parsed = normaliseHandle(ctx.body.handle);
          const handleType = parsed?.type ?? "unknown";

          const { checkRateLimit } = await import("@/lib/rate-limit");
          const limit = await checkRateLimit(
            `rl:otp:h:${handleBucket(parsed, ctx.body.handle)}`,
            HANDLE_LIMIT,
            WINDOW_SECONDS,
          );
          if (!limit.allowed) {
            log.info("otp_start", { handleType, outcome: "rate_limited" });
            throw new APIError("TOO_MANY_REQUESTS", { code: "RATE_LIMITED", message: "Too many requests." });
          }

          const { resolveVerifiedUser } = await import("@/identity/resolve");
          const outcome = await startOtpSignin(ctx.body.handle, {
            resolveUser: (p) => resolveVerifiedUser(p),
            store: verificationStore(ctx.context.internalAdapter),
            senders: { email: options.sendEmailOtp, sms: options.sendSmsOtp },
            devOtp: options.devOtp,
          });

          log.info("otp_start", { handleType, outcome });
          return ctx.json({ ok: true });
        },
      ),

      /**
       * POST /api/auth/sign-in/otp/verify — verify the OTP and open a session for
       * the resolved GLOBAL user id. Every reject is the same generic error as an
       * unknown handle.
       */
      verifyAliasOtp: createAuthEndpoint(
        "/sign-in/otp/verify",
        { method: "POST", body: verifyBody },
        async (ctx) => {
          const { resolveVerifiedUser } = await import("@/identity/resolve");
          const result = await verifyOtpSignin(ctx.body.handle, ctx.body.otp, {
            resolveUser: (p) => resolveVerifiedUser(p),
            store: verificationStore(ctx.context.internalAdapter),
          });

          if (!result.ok) {
            if (result.reason === "locked") {
              throw new APIError("FORBIDDEN", { code: "TOO_MANY_ATTEMPTS", message: "Too many attempts." });
            }
            throw invalidOtp();
          }

          const user = await ctx.context.internalAdapter.findUserById(result.userId);
          if (!user) throw invalidOtp();

          const session = await ctx.context.internalAdapter.createSession(result.userId);
          await setSessionCookie(ctx, { session, user });

          log.info("otp_verify", { userId: result.userId, outcome: "signed_in" });
          return ctx.json({
            token: session.token,
            user: { id: user.id, email: user.email, name: user.name },
          });
        },
      ),
    },
    // Per-IP, per-path limiting via Better Auth's own rate limiter (enabled in
    // production). Env-independent per-handle limiting is done in the handler above.
    rateLimit: [
      {
        pathMatcher: (path: string) => path.startsWith("/sign-in/otp/"),
        window: WINDOW_SECONDS,
        max: IP_LIMIT,
      },
    ],
  };
}
