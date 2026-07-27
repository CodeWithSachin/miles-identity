/**
 * `user_identity`/salesforce-linking helpers against a real disposable schema
 * — the unverified-vs-verified resolution split and the guarded contact-id
 * link are exactly the kind of behaviour a mock would not catch
 * (.agents/skills/postgres-migrations.md; prompts/013).
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createTestSchema, dropTestSchema, insertUser, type TestDatabase } from "../helpers/database";
import {
  createUnverifiedIdentity,
  createVerifiedIdentity,
  findUserIdByAnyHandle,
  findUserIdBySalesforceContactId,
  findUserIdByVerifiedHandle,
  insertSalesforceContactLinkOutboxRow,
  linkSalesforceContactId,
} from "@/db/identity";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestSchema();
});

afterAll(async () => {
  await dropTestSchema(db);
});

describe("createUnverifiedIdentity", () => {
  test("writes is_verified=false and verified_at=NULL", async () => {
    await insertUser(db.sql, "usr_unverified_1");
    const row = await createUnverifiedIdentity(
      { userId: "usr_unverified_1", type: "email", value: "lead1@example.com", source: "salesforce" },
      db.sql,
    );
    expect(row?.is_verified).toBe(false);
    expect(row?.is_primary).toBe(false);
    expect(row?.verified_at).toBeNull();
  });

  test("a repeat call for the same (type, value) writes no second row", async () => {
    await insertUser(db.sql, "usr_unverified_2a");
    await insertUser(db.sql, "usr_unverified_2b");
    await createUnverifiedIdentity(
      { userId: "usr_unverified_2a", type: "email", value: "dup-lead@example.com", source: "salesforce" },
      db.sql,
    );

    const second = await createUnverifiedIdentity(
      { userId: "usr_unverified_2b", type: "email", value: "dup-lead@example.com", source: "salesforce" },
      db.sql,
    );

    expect(second).toBeNull();
    expect(await findUserIdByAnyHandle("email", "dup-lead@example.com", db.sql)).toBe("usr_unverified_2a");
  });
});

describe("findUserIdByAnyHandle vs findUserIdByVerifiedHandle", () => {
  test("an unverified handle resolves via findUserIdByAnyHandle but not findUserIdByVerifiedHandle", async () => {
    await insertUser(db.sql, "usr_any_handle");
    await createUnverifiedIdentity(
      { userId: "usr_any_handle", type: "email", value: "unverified-only@example.com", source: "salesforce" },
      db.sql,
    );

    expect(await findUserIdByAnyHandle("email", "unverified-only@example.com", db.sql)).toBe("usr_any_handle");
    // This disagreement IS the security boundary (alias-identity.md rule 1):
    // an unverified handle must never resolve on a login/auth path.
    expect(await findUserIdByVerifiedHandle("email", "unverified-only@example.com", db.sql)).toBeNull();
  });

  test("a verified handle resolves via both", async () => {
    await insertUser(db.sql, "usr_verified_handle");
    await createVerifiedIdentity(
      { userId: "usr_verified_handle", type: "email", value: "verified@example.com", source: "lms" },
      db.sql,
    );

    expect(await findUserIdByAnyHandle("email", "verified@example.com", db.sql)).toBe("usr_verified_handle");
    expect(await findUserIdByVerifiedHandle("email", "verified@example.com", db.sql)).toBe("usr_verified_handle");
  });
});

describe("findUserIdBySalesforceContactId / linkSalesforceContactId", () => {
  test("returns null until a contact id is linked", async () => {
    await insertUser(db.sql, "usr_sfid_1");
    expect(await findUserIdBySalesforceContactId("003xx0000000001", db.sql)).toBeNull();

    expect(await linkSalesforceContactId("usr_sfid_1", "003xx0000000001", db.sql)).toBe(true);
    expect(await findUserIdBySalesforceContactId("003xx0000000001", db.sql)).toBe("usr_sfid_1");
  });

  test("refuses to overwrite an existing different link", async () => {
    await insertUser(db.sql, "usr_sfid_2");
    await linkSalesforceContactId("usr_sfid_2", "003xx0000000002", db.sql);

    expect(await linkSalesforceContactId("usr_sfid_2", "003xx0000000099", db.sql)).toBe(false);
    expect(await findUserIdBySalesforceContactId("003xx0000000002", db.sql)).toBe("usr_sfid_2");
  });
});

describe("insertSalesforceContactLinkOutboxRow", () => {
  test("writes a pending salesforce_contact_link row", async () => {
    await insertUser(db.sql, "usr_outbox_link");
    await insertSalesforceContactLinkOutboxRow(
      { contactId: "003xx0000000003", userId: "usr_outbox_link" },
      db.sql,
    );

    const rows = (await db.sql`
      SELECT aggregate, event_type, payload, processed_at FROM outbox
      WHERE payload->>'userId' = ${"usr_outbox_link"}
    `) as { aggregate: string; event_type: string; payload: unknown; processed_at: Date | null }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      aggregate: "salesforce_contact_link",
      event_type: "link",
      payload: { contactId: "003xx0000000003", userId: "usr_outbox_link" },
    });
    expect(rows[0]?.processed_at).toBeNull();
  });
});
