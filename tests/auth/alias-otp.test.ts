/**
 * The `aliasOtp` plugin adapter. The sign-in FLOW is proven in
 * tests/services/otp-signin.test.ts; here we cover the plugin's own glue that a
 * service test cannot reach: the store-adapter method mapping (a typo here would
 * silently break every OTP login), the rate-limit bucket, and the plugin shape —
 * including that it declares NO schema, so registering it adds no Better Auth
 * table (acceptance criterion). The endpoint handlers themselves are thin wiring
 * over these tested pieces plus `setSessionCookie`, verified end-to-end by the
 * manual curl steps in prompts/005.
 */

import { test, expect, describe, mock } from "bun:test";
import { aliasOtp, verificationStore, handleBucket } from "@/auth/alias-otp";

const noopSender = async (): Promise<void> => {};

describe("aliasOtp plugin shape", () => {
  const plugin = aliasOtp({ sendEmailOtp: noopSender, sendSmsOtp: noopSender });

  test("registers the two sign-in endpoints under a stable id", () => {
    expect(plugin.id).toBe("alias-otp");
    expect(Object.keys(plugin.endpoints)).toEqual(["startAliasOtp", "verifyAliasOtp"]);
  });

  // If the plugin declared a `schema`, `bunx auth generate` would emit a new table.
  // It must not — OTP state reuses the existing `verification` store.
  test("declares no schema, so it adds no Better Auth table", () => {
    expect("schema" in plugin).toBe(false);
  });

  test("rate-limits only the otp sign-in paths", () => {
    const matcher = plugin.rateLimit[0]!.pathMatcher;
    expect(matcher("/sign-in/otp/start")).toBe(true);
    expect(matcher("/sign-in/otp/verify")).toBe(true);
    expect(matcher("/sign-in/email-otp")).toBe(false);
    expect(matcher("/sign-in/magic-link")).toBe(false);
  });
});

describe("verificationStore adapter", () => {
  function fakeAdapter() {
    return {
      createVerificationValue: mock(async (_d: { identifier: string; value: string; expiresAt: Date }) => ({})),
      findVerificationValue: mock(async (_id: string) => ({ value: "v", expiresAt: new Date(0) }) as { value: string; expiresAt: Date } | null),
      updateVerificationByIdentifier: mock(async (_id: string, _d: { value: string }) => ({})),
      deleteVerificationByIdentifier: mock(async (_id: string) => ({})),
    };
  }

  test("maps create to createVerificationValue with the identifier, value and expiry", async () => {
    const adapter = fakeAdapter();
    const at = new Date(123456);
    await verificationStore(adapter).create("id-1", "val", at);
    expect(adapter.createVerificationValue).toHaveBeenCalledTimes(1);
    expect(adapter.createVerificationValue.mock.calls[0]![0]).toEqual({
      identifier: "id-1",
      value: "val",
      expiresAt: at,
    });
  });

  test("maps find to findVerificationValue and passes through value + expiry", async () => {
    const adapter = fakeAdapter();
    const found = await verificationStore(adapter).find("id-1");
    expect(adapter.findVerificationValue).toHaveBeenCalledWith("id-1");
    expect(found).toEqual({ value: "v", expiresAt: new Date(0) });
  });

  test("find returns null when the record is absent", async () => {
    const adapter = fakeAdapter();
    adapter.findVerificationValue.mockResolvedValueOnce(null);
    expect(await verificationStore(adapter).find("missing")).toBeNull();
  });

  test("maps update to updateVerificationByIdentifier and delete to delete", async () => {
    const adapter = fakeAdapter();
    const store = verificationStore(adapter);
    await store.update("id-1", "newval");
    await store.delete("id-1");
    expect(adapter.updateVerificationByIdentifier).toHaveBeenCalledWith("id-1", { value: "newval" });
    expect(adapter.deleteVerificationByIdentifier).toHaveBeenCalledWith("id-1");
  });
});

describe("handleBucket", () => {
  test("is deterministic and casing/whitespace-insensitive for the same handle", () => {
    const a = handleBucket({ type: "email", value: "a@b.com" }, "a@b.com");
    const b = handleBucket({ type: "email", value: "a@b.com" }, "  A@B.com ");
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
  });

  test("differs for different handles and never contains the raw handle", () => {
    const a = handleBucket({ type: "email", value: "a@b.com" }, "a@b.com");
    const c = handleBucket({ type: "email", value: "c@d.com" }, "c@d.com");
    expect(a).not.toBe(c);
    expect(a).not.toContain("a@b.com");
  });

  test("hashes an unclassifiable handle from the raw string", () => {
    expect(handleBucket(null, "junk")).toHaveLength(32);
  });
});
