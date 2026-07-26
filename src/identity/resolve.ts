/**
 * Alias resolution — the core domain (AGENTS.md: identity/). Two functions with
 * two different callers, kept apart on purpose:
 *
 *   resolveHandle       — what the enumeration-safe /resolve endpoint returns.
 *                         A pure function of the handle, NEVER of whether a user
 *                         exists. That existence-independence IS the anti-oracle.
 *   resolveVerifiedUser — the verified-only handle → user_id primitive. Its
 *                         result DOES depend on existence, so it stays server-side
 *                         (step 5's OTP send / alias login), never on the /resolve
 *                         response path.
 */

import { sql, type SQL } from "bun";
import type { IdentityType } from "@/db/types";
import { findUserIdByVerifiedHandle } from "@/db/identity";

export type ResolveResult = { methods: string[] };

/**
 * The login methods the screen should offer for a handle. Derived from the
 * handle alone, so a hit and a miss produce byte-identical responses.
 *
 * Today the only wired sign-in method is password (step 3), so this is constant.
 * ponytail: step 5 branches on `_parsed.type` to add "email_otp" (email) /
 * "sms_otp" (phone) — kept derived from the TYPE, never from a resolved user,
 * so the response never becomes an existence oracle.
 */
export function resolveHandle(_parsed: { type: IdentityType; value: string } | null): ResolveResult {
  return { methods: ["password"] };
}

/**
 * A normalised handle → the id of the user it verifiably belongs to, or null.
 * The primitive the passwordless and alias-login flows build on. `client` is
 * injectable for tests; production callers pass none.
 */
export function resolveVerifiedUser(
  parsed: { type: IdentityType; value: string },
  client: SQL = sql,
): Promise<string | null> {
  return findUserIdByVerifiedHandle(parsed.type, parsed.value, client);
}
