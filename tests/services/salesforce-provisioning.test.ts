/**
 * Resolve-or-create/grant/outbox logic in `src/services/salesforce-
 * provisioning.ts`, driven through injected fakes (same style as
 * tests/services/vendor-sso.test.ts) — fast, no database. Real-Postgres
 * behaviour of the collaborators is proven separately in tests/db/identity.test.ts
 * and tests/db/access.test.ts.
 */

import { test, expect, describe, mock } from "bun:test";
import type { SQL } from "bun";
import {
  provisionFromSalesforce,
  type ProvisionFromSalesforceDeps,
  type ProvisionFromSalesforceInput,
} from "@/services/salesforce-provisioning";
import { ValidationError } from "@/lib/errors";
import type { UserIdentityRow, UserProductAccessRow } from "@/db/types";

const TX_MARKER = { tx: true } as unknown as SQL;

function fakeSql(): SQL {
  return {
    begin: async (fn: (tx: SQL) => Promise<void>) => {
      await fn(TX_MARKER);
    },
  } as unknown as SQL;
}

function identityRow(overrides: Partial<UserIdentityRow> = {}): UserIdentityRow {
  return {
    id: "idt_1",
    user_id: "usr_1",
    type: "email",
    value: "lead@example.com",
    is_primary: false,
    is_verified: false,
    source: "salesforce",
    verified_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

function accessRow(overrides: Partial<UserProductAccessRow> = {}): UserProductAccessRow {
  return {
    id: "acc_1",
    user_id: "usr_1",
    product_id: "masterclass",
    role: "NORMAL",
    vendor_id: null,
    status: "active",
    granted_by: "system:salesforce-provisioning",
    granted_at: new Date(),
    revoked_at: null,
    ...overrides,
  };
}

function baseInput(overrides: Partial<ProvisionFromSalesforceInput> = {}): ProvisionFromSalesforceInput {
  return {
    contactId: "003xx0000000001",
    email: "New.Lead@Example.com",
    firstName: "New",
    lastName: "Lead",
    products: ["masterclass"],
    ...overrides,
  };
}

function baseDeps(overrides: Partial<ProvisionFromSalesforceDeps> = {}): ProvisionFromSalesforceDeps {
  return {
    findUserIdBySalesforceContactId: mock(async () => null),
    identityValueExists: mock(async () => false),
    findUserIdByAnyHandle: mock(async () => null),
    linkSalesforceContactId: mock(async () => true),
    createUser: mock(async () => ({ id: "usr_new" })),
    createUnverifiedIdentity: mock(async () => identityRow()),
    grantAccess: mock(async () => accessRow()),
    insertSalesforceContactLinkOutboxRow: mock(async () => undefined),
    sql: fakeSql(),
    ...overrides,
  };
}

describe("provisionFromSalesforce", () => {
  test("first-time contact + unclaimed email creates a new user and grants NORMAL for each product", async () => {
    const deps = baseDeps();

    const result = await provisionFromSalesforce(baseInput({ products: ["masterclass", "lms"] }), deps);

    expect(result).toEqual({ userId: "usr_new" });
    expect(deps.createUser).toHaveBeenCalledTimes(1);
    expect(deps.createUser).toHaveBeenCalledWith({
      email: "new.lead@example.com",
      name: "New Lead",
      salesforceContactId: "003xx0000000001",
    });
    expect(deps.grantAccess).toHaveBeenCalledTimes(2);
    for (const call of (deps.grantAccess as ReturnType<typeof mock>).mock.calls) {
      expect(call[0]).toMatchObject({ userId: "usr_new", role: "NORMAL", vendorId: null });
    }
    expect(deps.insertSalesforceContactLinkOutboxRow).toHaveBeenCalledWith(
      { contactId: "003xx0000000001", userId: "usr_new" },
      TX_MARKER,
    );
  });

  test("a repeat contactId is idempotent: createUser is never called again", async () => {
    const deps = baseDeps({ findUserIdBySalesforceContactId: mock(async () => "usr_existing") });

    const result = await provisionFromSalesforce(baseInput(), deps);

    expect(result).toEqual({ userId: "usr_existing" });
    expect(deps.createUser).not.toHaveBeenCalled();
    expect(deps.identityValueExists).not.toHaveBeenCalled();
  });

  test("first-time contactId + already-claimed email resolves to the existing owner instead of creating a user", async () => {
    const deps = baseDeps({
      identityValueExists: mock(async () => true),
      findUserIdByAnyHandle: mock(async () => "usr_owner"),
    });

    const result = await provisionFromSalesforce(baseInput(), deps);

    expect(result).toEqual({ userId: "usr_owner" });
    expect(deps.createUser).not.toHaveBeenCalled();
    expect(deps.linkSalesforceContactId).toHaveBeenCalledWith("usr_owner", "003xx0000000001");
    expect(deps.grantAccess).toHaveBeenCalledWith(
      { userId: "usr_owner", productId: "masterclass", role: "NORMAL", vendorId: null, grantedBy: "system:salesforce-provisioning" },
      TX_MARKER,
    );
  });

  test("negative: resolved user already linked to a different Salesforce contact throws ValidationError", async () => {
    const deps = baseDeps({
      identityValueExists: mock(async () => true),
      findUserIdByAnyHandle: mock(async () => "usr_owner"),
      linkSalesforceContactId: mock(async () => false),
    });

    await expect(provisionFromSalesforce(baseInput(), deps)).rejects.toBeInstanceOf(ValidationError);
    expect(deps.grantAccess).not.toHaveBeenCalled();
    expect(deps.insertSalesforceContactLinkOutboxRow).not.toHaveBeenCalled();
  });

  test("products: [] grants nothing but still writes the identity and outbox row", async () => {
    const deps = baseDeps();

    await provisionFromSalesforce(baseInput({ products: [] }), deps);

    expect(deps.grantAccess).not.toHaveBeenCalled();
    expect(deps.createUnverifiedIdentity).toHaveBeenCalled();
    expect(deps.insertSalesforceContactLinkOutboxRow).toHaveBeenCalled();
  });

  test("an unparseable phone is dropped, not a hard failure", async () => {
    const deps = baseDeps();

    await provisionFromSalesforce(baseInput({ phone: "not-a-phone" }), deps);

    expect(deps.createUnverifiedIdentity).toHaveBeenCalledTimes(1); // email only
  });

  test("a valid phone is attached as a second unverified identity", async () => {
    const deps = baseDeps();

    await provisionFromSalesforce(baseInput({ phone: "+919876543210" }), deps);

    expect(deps.createUnverifiedIdentity).toHaveBeenCalledTimes(2);
    expect(deps.createUnverifiedIdentity).toHaveBeenCalledWith(
      { userId: "usr_new", type: "phone", value: "+919876543210", source: "salesforce" },
      TX_MARKER,
    );
  });
});
