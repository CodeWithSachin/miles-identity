/**
 * importLegacyMasterclassUsers (src/services/legacy-import.ts), driven through
 * injected fakes — same style as tests/db/seed-oauth-clients.test.ts. The real
 * legacy-DB read and Better-Auth-adapter writes are exercised by the CLI
 * entrypoint against a live database, not here.
 */

import { test, expect, describe, mock } from "bun:test";
import { importLegacyMasterclassUsers, type ImportDeps } from "@/services/legacy-import";
import type { LegacyMasterclassAccount } from "@/integrations/legacy-masterclass-db";

function account(overrides: Partial<LegacyMasterclassAccount> = {}): LegacyMasterclassAccount {
  return {
    email: "student@example.com",
    password: "pbkdf2_sha256$260000$salt$hash",
    isActive: true,
    firstName: "Ada",
    lastName: "Lovelace",
    ...overrides,
  };
}

function deps(overrides: Partial<ImportDeps> = {}): ImportDeps {
  return {
    fetchAccounts: mock(async () => [account()]),
    identityValueExists: mock(async () => false),
    createVerifiedIdentity: mock(async () => ({})),
    createUser: mock(async () => ({ id: "usr_new" })),
    createAccount: mock(async () => ({})),
    ...overrides,
  };
}

describe("importLegacyMasterclassUsers", () => {
  test("imports a fresh, active legacy account", async () => {
    const d = deps();
    const summary = await importLegacyMasterclassUsers(d);

    expect(summary).toEqual({ imported: 1, skippedExisting: 0, skippedInactive: 0, skippedInvalid: 0 });
    expect(d.createUser).toHaveBeenCalledWith({
      email: "student@example.com",
      name: "Ada Lovelace",
      importedHashAlgo: "django_pbkdf2",
    });
    expect(d.createAccount).toHaveBeenCalledWith({
      userId: "usr_new",
      accountId: "usr_new",
      providerId: "credential",
      password: "pbkdf2_sha256$260000$salt$hash",
    });
    expect(d.createVerifiedIdentity).toHaveBeenCalledWith({
      userId: "usr_new",
      type: "email",
      value: "student@example.com",
      source: "masterclass",
    });
  });

  test("skips an email already claimed by any existing identity — never re-verifies someone else's handle", async () => {
    const d = deps({ identityValueExists: mock(async () => true) });
    const summary = await importLegacyMasterclassUsers(d);

    expect(summary).toEqual({ imported: 0, skippedExisting: 1, skippedInactive: 0, skippedInvalid: 0 });
    expect(d.createUser).not.toHaveBeenCalled();
    expect(d.createVerifiedIdentity).not.toHaveBeenCalled();
  });

  test("skips an inactive legacy row", async () => {
    const d = deps({ fetchAccounts: mock(async () => [account({ isActive: false })]) });
    const summary = await importLegacyMasterclassUsers(d);

    expect(summary).toEqual({ imported: 0, skippedExisting: 0, skippedInactive: 1, skippedInvalid: 0 });
    expect(d.createUser).not.toHaveBeenCalled();
  });

  test("skips a row with an unclassifiable email", async () => {
    const d = deps({ fetchAccounts: mock(async () => [account({ email: "not-an-email" })]) });
    const summary = await importLegacyMasterclassUsers(d);

    expect(summary).toEqual({ imported: 0, skippedExisting: 0, skippedInactive: 0, skippedInvalid: 1 });
    expect(d.createUser).not.toHaveBeenCalled();
  });

  test("falls back to the email as the display name when Django has no first/last name", async () => {
    const d = deps({ fetchAccounts: mock(async () => [account({ firstName: "", lastName: "" })]) });
    await importLegacyMasterclassUsers(d);

    expect(d.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ name: "student@example.com" }),
    );
  });
});
