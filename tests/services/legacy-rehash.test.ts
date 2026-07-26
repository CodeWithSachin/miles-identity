/**
 * rehashLegacyPasswordOnSignIn (src/services/legacy-rehash.ts), driven through
 * injected fakes — same style as tests/services/otp-signin.test.ts.
 */

import { test, expect, describe, mock } from "bun:test";
import { rehashLegacyPasswordOnSignIn, type RehashDeps } from "@/services/legacy-rehash";

function deps(overrides: Partial<RehashDeps> = {}): RehashDeps {
  return {
    findUserByEmail: mock(async () => ({
      user: { id: "usr_1", importedHashAlgo: "django_pbkdf2" },
      accounts: [{ id: "acc_1", providerId: "credential" }],
    })),
    updateAccount: mock(async () => undefined),
    updateUser: mock(async () => undefined),
    hashPassword: mock(async () => "$argon2id$rehashed"),
    ...overrides,
  };
}

describe("rehashLegacyPasswordOnSignIn", () => {
  test("rehashes and clears importedHashAlgo for an imported account", async () => {
    const d = deps();
    const rehashed = await rehashLegacyPasswordOnSignIn("user@example.com", "the password", d);

    expect(rehashed).toBe(true);
    expect(d.hashPassword).toHaveBeenCalledWith("the password");
    expect(d.updateAccount).toHaveBeenCalledWith("acc_1", { password: "$argon2id$rehashed" });
    expect(d.updateUser).toHaveBeenCalledWith("usr_1", { importedHashAlgo: null });
  });

  test("is a no-op for a user that was never imported", async () => {
    const d = deps({
      findUserByEmail: mock(async () => ({
        user: { id: "usr_2", importedHashAlgo: null },
        accounts: [{ id: "acc_2", providerId: "credential" }],
      })),
    });

    expect(await rehashLegacyPasswordOnSignIn("user@example.com", "pw", d)).toBe(false);
    expect(d.updateAccount).not.toHaveBeenCalled();
    expect(d.updateUser).not.toHaveBeenCalled();
  });

  test("is a no-op when the user does not exist", async () => {
    const d = deps({ findUserByEmail: mock(async () => null) });
    expect(await rehashLegacyPasswordOnSignIn("nope@example.com", "pw", d)).toBe(false);
  });

  test("is a no-op when there is no credential-provider account", async () => {
    const d = deps({
      findUserByEmail: mock(async () => ({
        user: { id: "usr_3", importedHashAlgo: "django_pbkdf2" },
        accounts: [{ id: "acc_3", providerId: "google" }],
      })),
    });

    expect(await rehashLegacyPasswordOnSignIn("user@example.com", "pw", d)).toBe(false);
    expect(d.updateAccount).not.toHaveBeenCalled();
  });
});
