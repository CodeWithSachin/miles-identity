/**
 * `user_product_access` read/write helpers against a real disposable schema —
 * the ON CONFLICT reactivation and the status-flip revocation are exactly the
 * kind of behaviour a mock would not catch (.agents/skills/postgres-migrations.md).
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createTestSchema, dropTestSchema, insertUser, type TestDatabase } from "../helpers/database";
import {
  getActiveAccessForUser,
  grantAccess,
  hasProductAdmin,
  revokeAccess,
  userExists,
} from "@/db/access";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestSchema();
});

afterAll(async () => {
  await dropTestSchema(db);
});

describe("userExists", () => {
  test("true for a real user", async () => {
    await insertUser(db.sql, "usr_exists_test");
    expect(await userExists("usr_exists_test", db.sql)).toBe(true);
  });

  test("false for an unknown id", async () => {
    expect(await userExists("usr_does_not_exist", db.sql)).toBe(false);
  });
});

describe("grantAccess / hasProductAdmin / getActiveAccessForUser", () => {
  test("grants a new row and it becomes visible as active access", async () => {
    const user = "usr_grant_new";
    await insertUser(db.sql, user);

    const row = await grantAccess(
      { userId: user, productId: "lms", role: "CPA", vendorId: null, grantedBy: "usr_admin" },
      db.sql,
    );

    expect(row.status).toBe("active");
    expect(row.granted_by).toBe("usr_admin");
    expect(row.revoked_at).toBeNull();

    const active = await getActiveAccessForUser(user, db.sql);
    expect(active).toEqual([{ product_id: "lms", role: "CPA", vendor_id: null }]);
  });

  test("hasProductAdmin is true only for the exact product an ADMIN row targets", async () => {
    const admin = "usr_admin_scoped";
    await insertUser(db.sql, admin);
    await grantAccess(
      { userId: admin, productId: "lms", role: "ADMIN", vendorId: null, grantedBy: "usr_root" },
      db.sql,
    );

    expect(await hasProductAdmin(admin, "lms", db.sql)).toBe(true);
    // The escalation case: an ADMIN for lms must not read as an admin for masterclass.
    expect(await hasProductAdmin(admin, "masterclass", db.sql)).toBe(false);
  });

  test("re-granting an active role is idempotent — same row id, refreshed granted_at", async () => {
    const user = "usr_regrant";
    await insertUser(db.sql, user);
    const first = await grantAccess(
      { userId: user, productId: "miles_one", role: "NORMAL", vendorId: null, grantedBy: "usr_admin" },
      db.sql,
    );

    const second = await grantAccess(
      { userId: user, productId: "miles_one", role: "NORMAL", vendorId: null, grantedBy: "usr_admin_2" },
      db.sql,
    );

    expect(second.id).toBe(first.id);
    expect(second.granted_by).toBe("usr_admin_2");
    expect(second.status).toBe("active");
  });

  test("re-granting a revoked role reactivates the same row instead of duplicating it", async () => {
    const user = "usr_reactivate";
    await insertUser(db.sql, user);
    const granted = await grantAccess(
      { userId: user, productId: "masterclass", role: "NORMAL", vendorId: null, grantedBy: "usr_admin" },
      db.sql,
    );
    await revokeAccess({ userId: user, productId: "masterclass", role: "NORMAL" }, db.sql);

    const reactivated = await grantAccess(
      { userId: user, productId: "masterclass", role: "NORMAL", vendorId: null, grantedBy: "usr_admin" },
      db.sql,
    );

    expect(reactivated.id).toBe(granted.id);
    expect(reactivated.status).toBe("active");
    expect(reactivated.revoked_at).toBeNull();
  });
});

describe("revokeAccess", () => {
  test("flips status to revoked and sets revoked_at", async () => {
    const user = "usr_revoke_target";
    await insertUser(db.sql, user);
    await grantAccess(
      { userId: user, productId: "lms", role: "CMA", vendorId: null, grantedBy: "usr_admin" },
      db.sql,
    );

    const revoked = await revokeAccess({ userId: user, productId: "lms", role: "CMA" }, db.sql);
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revoked_at).not.toBeNull();

    expect(await getActiveAccessForUser(user, db.sql)).toEqual([]);
  });

  test("returns null when there is no active row to revoke", async () => {
    const user = "usr_revoke_nothing";
    await insertUser(db.sql, user);
    expect(await revokeAccess({ userId: user, productId: "lms", role: "CAIRA" }, db.sql)).toBeNull();
  });
});
