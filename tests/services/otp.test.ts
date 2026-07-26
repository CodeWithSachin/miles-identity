import { test, expect, describe } from "bun:test";
import { generateOtp, hashOtp, verifyOtpHash, otpIdentifier } from "@/services/otp";

describe("generateOtp", () => {
  test("is six digits by default", () => {
    for (let i = 0; i < 50; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });

  test("honours a custom length and stays zero-padded", () => {
    for (let i = 0; i < 50; i++) expect(generateOtp(4)).toMatch(/^\d{4}$/);
  });

  test("is not a constant (sanity check on randomness)", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateOtp()));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("hashOtp / verifyOtpHash", () => {
  test("the hash never contains the code", async () => {
    const otp = "123456";
    const hash = await hashOtp(otp);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain(otp);
  });

  test("the correct code verifies and a wrong one does not", async () => {
    const hash = await hashOtp("246810");
    expect(await verifyOtpHash("246810", hash)).toBe(true);
    expect(await verifyOtpHash("999999", hash)).toBe(false);
  });
});

describe("otpIdentifier", () => {
  test("is deterministic for the same handle", () => {
    expect(otpIdentifier("email", "a@b.com")).toBe(otpIdentifier("email", "a@b.com"));
  });

  test("separates email and phone with the same value", () => {
    expect(otpIdentifier("email", "x")).not.toBe(otpIdentifier("phone", "x"));
  });
});
