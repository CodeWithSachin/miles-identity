import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createTestSchema, dropTestSchema, insertUser, type TestDatabase } from "../helpers/database";
import { newId, type IdentityType } from "@/db/types";
import { resolveVerifiedUser, resolveHandle } from "@/identity/resolve";
import { normaliseHandle } from "@/identity/normalise";

let db: TestDatabase;
const USER = "usr_resolve_owner_aaaaaa";

/** Narrow away a null normalisation result without an `as` cast. */
function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`expected ${what} to be non-null`);
  return value;
}

async function seedIdentity(type: IdentityType, value: string, isVerified: boolean): Promise<void> {
  await db.sql`
    INSERT INTO user_identity (id, user_id, type, value, is_primary, is_verified, source, verified_at)
    VALUES (${newId("identity")}, ${USER}, ${type}, ${value}, ${false}, ${isVerified}, ${"self"},
            ${isVerified ? new Date() : null})
  `;
}

beforeAll(async () => {
  db = await createTestSchema();
  await insertUser(db.sql, USER);
  await seedIdentity("email", "known@example.com", true);
  await seedIdentity("email", "pending@example.com", false); // unverified alias
  await seedIdentity("phone", "+919811100777", true);
});

afterAll(async () => {
  await dropTestSchema(db);
});

describe("resolveVerifiedUser", () => {
  test("resolves a verified email handle to its user", async () => {
    expect(await resolveVerifiedUser({ type: "email", value: "known@example.com" }, db.sql)).toBe(USER);
  });

  // Normalise BEFORE the query: a differently-cased handle must still hit, because
  // the stored value is normalised. Comparing raw-on-read would miss it.
  test("hits after normalisation of a differently-cased email", async () => {
    const parsed = required(normaliseHandle("  KNOWN@Example.com "), "parsed email");
    expect(await resolveVerifiedUser(parsed, db.sql)).toBe(USER);
  });

  test("hits a phone stored as E.164 when the user typed a bare 10-digit number", async () => {
    const parsed = required(normaliseHandle("9811100777"), "parsed phone");
    expect(parsed).toEqual({ type: "phone", value: "+919811100777" });
    expect(await resolveVerifiedUser(parsed, db.sql)).toBe(USER);
  });

  test("returns null for an unknown handle", async () => {
    expect(await resolveVerifiedUser({ type: "email", value: "nobody@example.com" }, db.sql)).toBeNull();
  });

  // The mandated negative test: an unverified alias must NEVER resolve, because
  // resolving is the gate to authentication (takeover path 1).
  test("returns null for an UNVERIFIED handle", async () => {
    expect(await resolveVerifiedUser({ type: "email", value: "pending@example.com" }, db.sql)).toBeNull();
  });
});

describe("resolveHandle — the enumeration-safe offer", () => {
  test("offers password for a classified handle", () => {
    expect(resolveHandle({ type: "email", value: "known@example.com" })).toEqual({ methods: ["password"] });
  });

  test("offers the identical set for an unclassifiable (null) handle — no disclosure", () => {
    expect(resolveHandle(null)).toEqual({ methods: ["password"] });
  });
});
