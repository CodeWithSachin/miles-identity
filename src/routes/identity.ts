/**
 * Identity HTTP routes. Thin: parse, rate-limit, call a service, shape a response
 * (AGENTS.md architecture). All logic lives in `identity/` and `lib/`.
 *
 * POST /api/identity/resolve is an enumeration oracle for 300K+ people
 * (security.md). Its defences live here and must not regress:
 *   - identical response for hit, miss, and unclassifiable handle — the body is a
 *     pure function of the handle, the endpoint never branches on existence;
 *   - rate limited per IP AND per handle;
 *   - the handle value is never logged (it is PII the logger's key-name denylist
 *     does not catch); log the handle TYPE only.
 */

import { redis } from "bun";
import type { Server } from "bun";
import type { RedisClient } from "bun";
import { z } from "zod";
import { normaliseHandle } from "@/identity/normalise";
import { resolveHandle } from "@/identity/resolve";
import { checkRateLimit } from "@/lib/rate-limit";
import { log } from "@/lib/logger";

const bodySchema = z.object({ handle: z.string().min(1).max(320) });

// Fixed-window policy. Per-handle bounds scanning one handle; per-IP bounds
// scanning many from one source. Constants, not config: they do not vary per
// environment. Move to lib/config only if ops needs to tune without a deploy.
const WINDOW_SECONDS = 60;
const HANDLE_LIMIT = 5;
const IP_LIMIT = 30;

const NO_STORE = { "cache-control": "no-store" } as const;

function handleBucket(parsed: { type: string; value: string } | null, raw: string): string {
  // Hash so raw emails/phones never sit in Redis; key on the normalised handle so
  // casing/whitespace variants share one bucket and cannot bypass the limit.
  const material = parsed ? `${parsed.type}:${parsed.value}` : raw.trim().toLowerCase();
  return new Bun.CryptoHasher("sha256").update(material).digest("hex").slice(0, 32);
}

export async function resolveRoute(
  req: Request,
  server: Server<undefined>,
  rateClient: RedisClient = redis,
): Promise<Response> {
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  const ip = server.requestIP(req)?.address ?? "unknown";
  const parsed = normaliseHandle(body.data.handle);
  const handleType = parsed?.type ?? "unknown";

  const [ipLimit, handleLimit] = await Promise.all([
    checkRateLimit(`rl:resolve:ip:${ip}`, IP_LIMIT, WINDOW_SECONDS, rateClient),
    checkRateLimit(`rl:resolve:h:${handleBucket(parsed, body.data.handle)}`, HANDLE_LIMIT, WINDOW_SECONDS, rateClient),
  ]);

  if (!ipLimit.allowed || !handleLimit.allowed) {
    log.info("identity_resolve", { handleType, outcome: "rate_limited" });
    const retryAfter = Math.max(ipLimit.retryAfterSeconds, handleLimit.retryAfterSeconds);
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "retry-after": String(retryAfter) } },
    );
  }

  log.info("identity_resolve", { handleType, outcome: "ok" });
  return Response.json(resolveHandle(parsed), { headers: NO_STORE });
}
