/**
 * `user_product_access` read/write helpers against a real disposable schema —
 * the ON CONFLICT reactivation and the status-flip revocation are exactly the
 * kind of behaviour a mock would not catch (.agents/skills/postgres-migrations.md).
 *
 * Uses its own schema-pinned `SQL` client (the `?options=-c search_path=...`
 * technique from tests/db/transaction.test.ts and tests/identity/merge.test.ts),
 * not `createTestSchema()`'s plain pooled client: `grantAccess`/`revokeAccess`
 * now call `client.begin(...)` (roadmap step 11's outbox emission), and a
 * transaction can be handed a different pooled connection than the one `SET
 * search_path` was run on — pinning search_path on the connection string
 * itself makes every connection in the pool correct, not just whichever one
 * happened to run the setup DDL.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { createTestSchema, dropTestSchema, insertUser, testDatabaseUrl, type TestDatabase } from "../helpers/database";
import {
  getActiveAccessForUser,
  grantAccess,
  hasProductAdmin,
  revokeAccess,
  userExists,
} from "@/db/access";
import { createVendor } from "@/db/vendor";

type OutboxRowForTest = { aggregate: string; event_type: string; payload: unknown };

async function outboxRowsFor(client: SQL, userId: string): Promise<OutboxRowForTest[]> {
  return (await client`
    SELECT aggregate, event_type, payload FROM outbox
    WHERE payload->>'userId' = ${userId}
    ORDER BY id
  `) as OutboxRowForTest[];
}

let raw: TestDatabase;
let client: SQL;

beforeAll(async () => {
  raw = await createTestSchema();
  client = new SQL(`${testDatabaseUrl()}?options=-c%20search_path%3D${raw.schema}`, { max: 4 });
});

afterAll(async () => {
  await client.close();
  await dropTestSchema(raw);
});

describe("userExists", () => {
  test("true for a real user", async () => {
    await insertUser(client, "usr_exists_test");
    expect(await userExists("usr_exists_test", client)).toBe(true);
  });

  test("false for an unknown id", async () => {
    expect(await userExists("usr_does_not_exist", client)).toBe(false);
  });
});

describe("grantAccess / hasProductAdmin / getActiveAccessForUser", () => {
  test("grants a new row and it becomes visible as active access", async () => {
    const user = "usr_grant_new";
    await insertUser(client, user);

    const row = await grantAccess(
      { userId: user, productId: "lms", role: "CPA", vendorId: null, grantedBy: "usr_admin" },
      client,
    );

    expect(row.status).toBe("active");
    expect(row.granted_by).toBe("usr_admin");
    expect(row.revoked_at).toBeNull();

    const active = await getActiveAccessForUser(user, client);
    expect(active).toEqual([{ product_id: "lms", role: "CPA", vendor_id: null }]);
  });

  test("hasProductAdmin is true only for the exact product an ADMIN row targets", async () => {
    const admin = "usr_admin_scoped";
    await insertUser(client, admin);
    await grantAccess(
      { userId: admin, productId: "lms", role: "ADMIN", vendorId: null, grantedBy: "usr_root" },
      client,
    );

    expect(await hasProductAdmin(admin, "lms", client)).toBe(true);
    // The escalation case: an ADMIN for lms must not read as an admin for masterclass.
    expect(await hasProductAdmin(admin, "masterclass", client)).toBe(false);
  });

  test("re-granting an active role is idempotent — same row id, refreshed granted_at", async () => {
    const user = "usr_regrant";
    await insertUser(client, user);
    const first = await grantAccess(
      { userId: user, productId: "miles_one", role: "NORMAL", vendorId: null, grantedBy: "usr_admin" },
      client,
    );

    const second = await grantAccess(
      { userId: user, productId: "miles_one", role: "NORMAL", vendorId: null, grantedBy: "usr_admin_2" },
      client,
    );

    expect(second.id).toBe(first.id);
    expect(second.granted_by).toBe("usr_admin_2");
    expect(second.status).toBe("active");
  });

  test("re-granting a revoked role reactivates the same row instead of duplicating it", async () => {
    const user = "usr_reactivate";
    await insertUser(client, user);
    const granted = await grantAccess(
      { userId: user, productId: "masterclass", role: "NORMAL", vendorId: null, grantedBy: "usr_admin" },
      client,
    );
    await revokeAccess({ userId: user, productId: "masterclass", role: "NORMAL" }, client);

    const reactivated = await grantAccess(
      { userId: user, productId: "masterclass", role: "NORMAL", vendorId: null, grantedBy: "usr_admin" },
      client,
    );

    expect(reactivated.id).toBe(granted.id);
    expect(reactivated.status).toBe("active");
    expect(reactivated.revoked_at).toBeNull();
  });
});

describe("revokeAccess", () => {
  test("flips status to revoked and sets revoked_at", async () => {
    const user = "usr_revoke_target";
    await insertUser(client, user);
    await grantAccess(
      { userId: user, productId: "lms", role: "CMA", vendorId: null, grantedBy: "usr_admin" },
      client,
    );

    const revoked = await revokeAccess({ userId: user, productId: "lms", role: "CMA" }, client);
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revoked_at).not.toBeNull();

    expect(await getActiveAccessForUser(user, client)).toEqual([]);
  });

  test("returns null when there is no active row to revoke", async () => {
    const user = "usr_revoke_nothing";
    await insertUser(client, user);
    expect(await revokeAccess({ userId: user, productId: "lms", role: "CAIRA" }, client)).toBeNull();
  });
});

describe("vendor_access outbox emission", () => {
  test("granting VENDOR_ADMIN writes exactly one matching outbox row in the same transaction", async () => {
    const user = "usr_outbox_grant_admin";
    await insertUser(client, user);
    const vendor = await createVendor({ name: "Outbox Vendor Admin Co", domain: "outbox-admin.example" }, client);

    await grantAccess(
      { userId: user, productId: "masterclass", role: "VENDOR_ADMIN", vendorId: vendor.id, grantedBy: "usr_admin" },
      client,
    );

    const rows = await outboxRowsFor(client, user);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      aggregate: "vendor_access",
      event_type: "granted",
      payload: { userId: user, vendorId: vendor.id, role: "VENDOR_ADMIN" },
    });
  });

  test("granting a non-vendor role writes zero outbox rows", async () => {
    const user = "usr_outbox_grant_none";
    await insertUser(client, user);

    await grantAccess(
      { userId: user, productId: "lms", role: "CPA", vendorId: null, grantedBy: "usr_admin" },
      client,
    );

    expect(await outboxRowsFor(client, user)).toEqual([]);
  });

  test("revoking an active VENDOR role writes a revoked outbox row", async () => {
    const user = "usr_outbox_revoke";
    await insertUser(client, user);
    const vendor = await createVendor({ name: "Outbox Vendor Revoke Co", domain: "outbox-revoke.example" }, client);
    await grantAccess(
      { userId: user, productId: "masterclass", role: "VENDOR", vendorId: vendor.id, grantedBy: "usr_admin" },
      client,
    );

    await revokeAccess({ userId: user, productId: "masterclass", role: "VENDOR" }, client);

    const rows = await outboxRowsFor(client, user);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      aggregate: "vendor_access",
      event_type: "revoked",
      payload: { userId: user, vendorId: vendor.id, role: "VENDOR" },
    });
  });

  test("revoking a role with no active row writes no outbox row", async () => {
    const user = "usr_outbox_revoke_noop";
    await insertUser(client, user);

    await revokeAccess({ userId: user, productId: "masterclass", role: "VENDOR" }, client);

    expect(await outboxRowsFor(client, user)).toEqual([]);
  });
});
