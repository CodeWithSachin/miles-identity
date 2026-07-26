/**
 * Django `pbkdf2_sha256` password verification — the one branch `Bun.password.verify`
 * cannot auto-detect (.agents/skills/better-auth.md, .agents/skills/bun-native.md).
 *
 * Format: `pbkdf2_sha256$<iterations>$<salt>$<base64 hash>`. Verified with
 * `node:crypto`'s `pbkdf2Sync` — a Bun-bundled built-in, not a new dependency
 * (AGENTS.md tech table).
 */

import { pbkdf2Sync, timingSafeEqual } from "node:crypto";

const DJANGO_PREFIX = "pbkdf2_sha256$";
const DKLEN_BYTES = 32; // Django's default for pbkdf2_sha256 (hashlib output size)

/**
 * Never throws — a malformed or non-Django hash is simply not a match.
 */
export function verifyDjangoPbkdf2(password: string, encoded: string): boolean {
  if (!encoded.startsWith(DJANGO_PREFIX)) return false;

  const parts = encoded.split("$");
  if (parts.length !== 4) return false;
  const [, iterationsRaw, salt, expectedBase64] = parts;

  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  if (!salt) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(expectedBase64 ?? "", "base64");
  } catch {
    return false;
  }
  if (expected.length !== DKLEN_BYTES) return false;

  const actual = pbkdf2Sync(password, salt, iterations, DKLEN_BYTES, "sha256");
  return timingSafeEqual(actual, expected);
}

/**
 * The full gate for an imported (Django PBKDF2) password hash: while
 * `legacyLoginEnabled` is false, it never verifies — regardless of whether the
 * password is correct — so the account fails exactly the same way a wrong
 * password already does (BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD in
 * src/auth.ts's `passwordHasher`, no new error branch). Extracted as a pure
 * function (flag passed in, not read from config) so both states are
 * unit-testable without fighting the memoised config/module-cache singleton —
 * same reasoning as `buildAccessTokenClaims` in src/services/access.ts.
 */
export function verifyLegacyPassword(password: string, hash: string, legacyLoginEnabled: boolean): boolean {
  if (!legacyLoginEnabled) return false;
  return verifyDjangoPbkdf2(password, hash);
}
