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
 * The login methods the screen should offer for a handle. Derived from the handle
 * TYPE alone — never from whether a user exists — so a hit and a miss for the same
 * handle produce byte-identical responses. The caller already knows their own
 * handle's type, so offering `email_otp` vs `sms_otp` discloses nothing.
 *
 * A phone handle gets SMS OTP, anything else (email, or an unclassifiable null)
 * gets email OTP; password (step 3) is offered alongside either.
 */
export function resolveHandle(parsed: { type: IdentityType; value: string } | null): ResolveResult {
  const otpMethod = parsed?.type === "phone" ? "sms_otp" : "email_otp";
  return { methods: [otpMethod, "password"] };
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
