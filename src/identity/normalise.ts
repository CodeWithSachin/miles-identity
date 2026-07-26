/**
 * Handle normalisation — run BEFORE the query, never on read. See
 * .agents/skills/alias-identity.md: comparing normalised-on-read against
 * raw-in-database is the bug that silently merges two strangers.
 *
 * The output of each function is exactly what migration 0002's CHECK constraints
 * accept, so a normalised handle is storable and a stored handle is findable.
 */

import type { IdentityType } from "@/db/types";

/**
 * Trim + lowercase. Deliberately does NOT strip Gmail dots or `+tags`: two
 * handles that differ textually are two handles, and stripping them silently
 * merges accounts. Idempotent.
 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const E164 = /^\+[1-9]\d{7,14}$/;
const INDIAN_MOBILE = /^0?([6-9]\d{9})$/;

/**
 * Best-effort E.164. Handles the two formats a user actually types on a login
 * screen: an already-`+`-prefixed E.164, and a bare 10-digit Indian mobile
 * (optionally one leading 0). Anything else returns null — treated as a miss,
 * never guessed at. Idempotent for any value it accepts.
 */
export function normalisePhone(raw: string): string | null {
  const stripped = raw.replace(/[\s\-()]/g, "");
  if (E164.test(stripped)) return stripped;
  // ponytail: bare 10-digit → +91 is the documented Indian default. Validate it
  // against a real sample before a batch job relies on it (step 9), per the skill.
  const indian = INDIAN_MOBILE.exec(stripped);
  return indian ? `+91${indian[1]}` : null;
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Classify a raw handle and normalise it. `@` → email; otherwise phone. An
 * unclassifiable handle returns null, which the resolve endpoint treats as a
 * miss — it never surfaces an "invalid handle" message that could disclose intent.
 */
export function normaliseHandle(raw: string): { type: IdentityType; value: string } | null {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) {
    const value = normaliseEmail(trimmed);
    return EMAIL_SHAPE.test(value) ? { type: "email", value } : null;
  }
  const value = normalisePhone(trimmed);
  return value === null ? null : { type: "phone", value };
}
