/**
 * Django `pbkdf2_sha256` verification (src/lib/pbkdf2.ts). The vector below is a
 * real Django-shaped hash for the password "correct horse battery staple",
 * computed independently with node:crypto's pbkdf2Sync at 260000 iterations
 * (Django's own default) to avoid testing the implementation against itself.
 */

import { test, expect, describe } from "bun:test";
import { pbkdf2Sync } from "node:crypto";
import { verifyDjangoPbkdf2 } from "@/lib/pbkdf2";

const PASSWORD = "correct horse battery staple";
const ITERATIONS = 260000;
const SALT = "somesalt123";

function djangoHash(password: string, salt: string, iterations: number): string {
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64");
  return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

describe("verifyDjangoPbkdf2", () => {
  test("verifies a correct password against a real Django-shaped hash", () => {
    const encoded = djangoHash(PASSWORD, SALT, ITERATIONS);
    expect(verifyDjangoPbkdf2(PASSWORD, encoded)).toBe(true);
  });

  test("rejects a wrong password", () => {
    const encoded = djangoHash(PASSWORD, SALT, ITERATIONS);
    expect(verifyDjangoPbkdf2("wrong password", encoded)).toBe(false);
  });

  test("rejects a non-Django hash string without throwing", () => {
    expect(verifyDjangoPbkdf2(PASSWORD, "$argon2id$v=19$m=65536,t=3,p=4$abc$def")).toBe(false);
  });

  test("rejects a malformed pbkdf2 hash (wrong segment count) without throwing", () => {
    expect(verifyDjangoPbkdf2(PASSWORD, "pbkdf2_sha256$260000$onlytwosegments")).toBe(false);
  });

  test("rejects a non-numeric iteration count without throwing", () => {
    const bad = `pbkdf2_sha256$notanumber$${SALT}$${Buffer.alloc(32).toString("base64")}`;
    expect(verifyDjangoPbkdf2(PASSWORD, bad)).toBe(false);
  });
});
