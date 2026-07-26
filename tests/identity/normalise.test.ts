import { test, expect, describe } from "bun:test";
import { normaliseEmail, normalisePhone, normaliseHandle } from "@/identity/normalise";

describe("normaliseEmail", () => {
  test("trims and lowercases", () => {
    expect(normaliseEmail("  Foo@Bar.com ")).toBe("foo@bar.com");
  });

  // The skill is explicit: two handles that differ textually are two handles.
  // Stripping dots or +tags silently merges accounts.
  test("does NOT strip dots or +tags", () => {
    expect(normaliseEmail("First.Last+promo@Gmail.com")).toBe("first.last+promo@gmail.com");
  });

  test("is idempotent", () => {
    const once = normaliseEmail("  Mixed.Case+X@Example.COM ");
    expect(normaliseEmail(once)).toBe(once);
  });
});

describe("normalisePhone", () => {
  test("passes a valid E.164 number through unchanged", () => {
    expect(normalisePhone("+919811100001")).toBe("+919811100001");
  });

  test("prefixes a bare 10-digit Indian mobile with +91", () => {
    expect(normalisePhone("9811100001")).toBe("+919811100001");
  });

  test("drops a single leading zero before prefixing", () => {
    expect(normalisePhone("09811100001")).toBe("+919811100001");
  });

  test("strips spaces, dashes and parentheses", () => {
    expect(normalisePhone("+91 (98111)-00001")).toBe("+919811100001");
  });

  test("rejects a non-mobile or too-short number as null", () => {
    expect(normalisePhone("12345")).toBeNull();
    expect(normalisePhone("5811100001")).toBeNull(); // leading 5 is not an Indian mobile
  });

  // Mirrors migration 0002's ck_identity_phone_e164, which rejects +0…
  test("rejects a +0-prefixed number", () => {
    expect(normalisePhone("+09811100001")).toBeNull();
  });

  test("is idempotent for an accepted value", () => {
    const once = normalisePhone("9811100001");
    expect(once).not.toBeNull();
    if (once !== null) expect(normalisePhone(once)).toBe(once);
  });
});

describe("normaliseHandle", () => {
  test("classifies and normalises an email", () => {
    expect(normaliseHandle("  Foo@Bar.com ")).toEqual({ type: "email", value: "foo@bar.com" });
  });

  test("classifies and normalises a phone", () => {
    expect(normaliseHandle("9811100001")).toEqual({ type: "phone", value: "+919811100001" });
  });

  test("returns null for an unclassifiable handle", () => {
    expect(normaliseHandle("not-an-email-or-phone")).toBeNull();
    expect(normaliseHandle("@@@")).toBeNull();
  });

  test("is idempotent on the classified value", () => {
    const first = normaliseHandle("First.Last@Example.com");
    expect(first).not.toBeNull();
    if (first !== null) expect(normaliseHandle(first.value)).toEqual(first);
  });
});
