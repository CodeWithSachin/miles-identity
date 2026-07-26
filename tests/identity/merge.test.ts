/**
 * mergeUsers (src/identity/merge.ts) against a real disposable schema — the
 * unique-constraint interactions (uq_primary_per_type, uq_access_user_product_role)
 * and the append-only trigger on identity_merge_log are exactly the kind of
 * behaviour a mock would not catch (.agents/skills/postgres-migrations.md).
 *
 * Uses its own schema-pinned `SQL` client (the `?options=-c search_path=...`
 * technique from tests/db/transaction.test.ts), not `createTestSchema()`'s
 * plain pooled client: `mergeUsers` calls `client.begin(...)`, and a
 * transaction can be handed a different pooled connection than the one
 * `SET search_path` was run on — pinning search_path on the connection string
 * itself makes every connection in the pool correct, not just whichever one
 * happened to run the setup DDL.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { SQL } from "bun";
import { createTestSchema, dropTestSchema, testDatabaseUrl, type TestDatabase } from "../helpers/database";
import { newId } from "@/db/types";
import { mergeUsers, type MergeDeps } from "@/identity/merge";

let raw: TestDatabase;
let db: SQL;

const SURVIVOR = "usr_survivor00000000000";
const LOSER = "usr_loser000000000000000";

async function insertUser(userId: string) {
  await db`
    INSERT INTO "user" (id, name, email, "emailVerified")
    VALUES (${userId}, ${"Test User"}, ${`${userId}@test.local`}, ${false})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function insertIdentity(userId: string, overrides: {
  type: "email" | "phone";
  value: string;
  isPrimary: boolean;
  verifiedAt: Date;
}) {
  await db`
    INSERT INTO user_identity (id, user_id, type, value, is_primary, is_verified, source, verified_at)
    VALUES (${newId("identity")}, ${userId}, ${overrides.type}, ${overrides.value}, ${overrides.isPrimary}, true, 'self', ${overrides.verifiedAt})
  `;
}

async function grantActiveAccess(userId: string, productId: string, role: string) {
  await db`
    INSERT INTO user_product_access (id, user_id, product_id, role, vendor_id, status, granted_by, granted_at)
    VALUES (${newId("access")}, ${userId}, ${productId}, ${role}, NULL, 'active', 'usr_admin', now())
  `;
}

async function insertOAuthClient(clientId: string) {
  await db`
    INSERT INTO "oauthClient" (id, "clientId", "redirectUris")
    VALUES (${newId("vendor")}, ${clientId}, ${JSON.stringify(["https://example.com/callback"])})
  `;
}

async function insertSession(id: string, userId: string) {
  await db`
    INSERT INTO "session" (id, "expiresAt", token, "userId", "updatedAt")
    VALUES (${id}, ${new Date(Date.now() + 3600_000)}, ${id}, ${userId}, ${new Date()})
  `;
}

async function insertAccessToken(id: string, userId: string, clientId: string) {
  await db`
    INSERT INTO "oauthAccessToken" (id, token, "clientId", "userId", "expiresAt", "createdAt", scopes)
    VALUES (${id}, ${id}, ${clientId}, ${userId}, ${new Date(Date.now() + 900_000)}, ${new Date()}, ${JSON.stringify(["openid"])})
  `;
}

async function countSessionsFor(userId: string): Promise<number> {
  const rows = (await db`SELECT count(*)::int AS n FROM "session" WHERE "userId" = ${userId}`) as { n: number }[];
  return rows[0]?.n ?? 0;
}

async function countAccessTokensFor(userId: string): Promise<number> {
  const rows = (await db`SELECT count(*)::int AS n FROM "oauthAccessToken" WHERE "userId" = ${userId}`) as { n: number }[];
  return rows[0]?.n ?? 0;
}

function testDeps(): MergeDeps {
  return {
    deleteUserSessions: async userId => {
      await db`DELETE FROM "session" WHERE "userId" = ${userId}`;
    },
    revokeOAuthTokensForUser: async userId => {
      await db`DELETE FROM "oauthAccessToken" WHERE "userId" = ${userId}`;
    },
  };
}

describe("mergeUsers", () => {
  beforeEach(async () => {
    raw = await createTestSchema();
    db = new SQL(`${testDatabaseUrl()}?options=-c%20search_path%3D${raw.schema}`, { max: 4 });
    await insertUser(SURVIVOR);
    await insertUser(LOSER);
  });

  afterEach(async () => {
    await db.close();
    await dropTestSchema(raw);
  });

  test("moves identities, unions access, logs once, and marks the loser merged — never deleting it", async () => {
    // Survivor already has a primary email; loser's email must NOT become a
    // second primary once moved.
    await insertIdentity(SURVIVOR, { type: "email", value: "survivor@example.com", isPrimary: true, verifiedAt: new Date("2024-01-01") });
    await insertIdentity(LOSER, { type: "email", value: "loser@example.com", isPrimary: true, verifiedAt: new Date("2024-02-01") });
    // Only the loser has a phone — the survivor must inherit it as primary.
    await insertIdentity(LOSER, { type: "phone", value: "+919876543210", isPrimary: true, verifiedAt: new Date("2024-02-01") });

    // A product only the loser had access to: must move to the survivor.
    await grantActiveAccess(LOSER, "masterclass", "ADMIN");
    // A product BOTH already hold with the same role: the loser's redundant
    // row must be left alone, not attempted twice against the unique index.
    await grantActiveAccess(SURVIVOR, "lms", "NORMAL");
    await grantActiveAccess(LOSER, "lms", "NORMAL");

    const result = await mergeUsers(
      { survivorId: SURVIVOR, loserId: LOSER, tier: "E", evidence: { nameA: "a", nameB: "b", similarity: 0.95 }, actor: "test" },
      testDeps(),
      db,
    );
    expect(result).toEqual({ merged: true });

    const identities = (await db`
      SELECT user_id, type, value, is_primary FROM user_identity ORDER BY type, value
    `) as { user_id: string; type: string; value: string; is_primary: boolean }[];
    expect(identities).toHaveLength(3);
    expect(identities.every(row => row.user_id === SURVIVOR)).toBe(true);

    const email = identities.filter(row => row.type === "email");
    expect(email.find(row => row.value === "survivor@example.com")?.is_primary).toBe(true);
    expect(email.find(row => row.value === "loser@example.com")?.is_primary).toBe(false);
    const phone = identities.find(row => row.type === "phone");
    expect(phone?.is_primary).toBe(true);

    const access = (await db`
      SELECT user_id, product_id, role, status FROM user_product_access ORDER BY product_id
    `) as { user_id: string; product_id: string; role: string; status: string }[];
    // masterclass/ADMIN moved to the survivor; one of the two lms/NORMAL rows
    // (whichever the loser's was) stays put rather than erroring.
    expect(access.filter(row => row.user_id === SURVIVOR && row.status === "active")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ product_id: "masterclass", role: "ADMIN" }),
        expect.objectContaining({ product_id: "lms", role: "NORMAL" }),
      ]),
    );

    const logs = (await db`
      SELECT survivor_user_id, merged_user_id, tier FROM identity_merge_log WHERE merged_user_id = ${LOSER}
    `) as { survivor_user_id: string; merged_user_id: string; tier: string }[];
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({ survivor_user_id: SURVIVOR, merged_user_id: LOSER, tier: "E" });

    const loserRow = (await db`SELECT status, merged_into_user_id FROM "user" WHERE id = ${LOSER}`) as {
      status: string;
      merged_into_user_id: string;
    }[];
    expect(loserRow).toHaveLength(1); // never deleted
    expect(loserRow[0]).toEqual({ status: "merged", merged_into_user_id: SURVIVOR });
  });

  test("revokes both users' sessions and oauthAccessToken rows", async () => {
    await insertOAuthClient("client_1");
    await insertSession("sess_survivor", SURVIVOR);
    await insertSession("sess_loser", LOSER);
    await insertAccessToken("tok_survivor", SURVIVOR, "client_1");
    await insertAccessToken("tok_loser", LOSER, "client_1");

    await mergeUsers({ survivorId: SURVIVOR, loserId: LOSER, tier: "A", evidence: {}, actor: "test" }, testDeps(), db);

    expect(await countSessionsFor(SURVIVOR)).toBe(0);
    expect(await countSessionsFor(LOSER)).toBe(0);
    expect(await countAccessTokensFor(SURVIVOR)).toBe(0);
    expect(await countAccessTokensFor(LOSER)).toBe(0);
  });

  test("is idempotent: merging an already-merged loser a second time is a no-op, not an error, and writes no second log row", async () => {
    const first = await mergeUsers(
      { survivorId: SURVIVOR, loserId: LOSER, tier: "A", evidence: {}, actor: "test" },
      testDeps(),
      db,
    );
    expect(first).toEqual({ merged: true });

    const second = await mergeUsers(
      { survivorId: SURVIVOR, loserId: LOSER, tier: "A", evidence: {}, actor: "test" },
      testDeps(),
      db,
    );
    expect(second).toEqual({ merged: false });

    const logs = (await db`
      SELECT id FROM identity_merge_log WHERE merged_user_id = ${LOSER}
    `) as { id: string }[];
    expect(logs).toHaveLength(1);
  });

  test("rejects merging a user with itself", async () => {
    await expect(
      mergeUsers({ survivorId: SURVIVOR, loserId: SURVIVOR, tier: "A", evidence: {}, actor: "test" }, testDeps(), db),
    ).rejects.toThrow("distinct");
  });
});
