/**
 * The flag gate for step 9's Masterclass legacy password import
 * (`MASTERCLASS_LEGACY_PASSWORD_LOGIN_ENABLED`, wired into
 * `passwordHasher.verify` in src/auth.ts). Tested against the pure,
 * flag-injected `verifyLegacyPassword` (src/lib/pbkdf2.ts) rather than the live
 * `@/auth` singleton — the singleton memoises config from `Bun.env` once per
 * process, so it cannot represent both flag states in one test run. See
 * .agents/skills/security.md: this is the negative test for an account
 * whose only credential is an imported, not-yet-rehashed legacy hash.
 */

import { test, expect, describe } from "bun:test";
import { pbkdf2Sync } from "node:crypto";
import { verifyLegacyPassword } from "@/lib/pbkdf2";

const PASSWORD = "the real legacy password";
const ITERATIONS = 260000;
const SALT = "somesalt123";

function djangoHash(password: string): string {
  const hash = pbkdf2Sync(password, SALT, ITERATIONS, 32, "sha256").toString("base64");
  return `pbkdf2_sha256$${ITERATIONS}$${SALT}$${hash}`;
}

describe("verifyLegacyPassword — MASTERCLASS_LEGACY_PASSWORD_LOGIN_ENABLED gate", () => {
  test("flag off rejects the CORRECT legacy password (fail-closed default)", () => {
    const hash = djangoHash(PASSWORD);
    expect(verifyLegacyPassword(PASSWORD, hash, false)).toBe(false);
  });

  test("flag on accepts the correct legacy password", () => {
    const hash = djangoHash(PASSWORD);
    expect(verifyLegacyPassword(PASSWORD, hash, true)).toBe(true);
  });

  test("flag on still rejects a wrong password", () => {
    const hash = djangoHash(PASSWORD);
    expect(verifyLegacyPassword("wrong password", hash, true)).toBe(false);
  });
});
