/**
 * Every save rule in AGENTS.md asserted as a REJECTED write.
 *
 * These are the negative tests the testing skill asks for. A schema that merely
 * has the right columns is not the deliverable — a schema that makes the wrong
 * row unrepresentable is.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { withTestSchema, createTestSchema, dropTestSchema, expectRejection, type TestDatabase } from "../helpers/database";
import { newId } from "@/db/types";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestSchema();
});

afterAll(async () => {
  await dropTestSchema(db);
});

const USER_A = "usr_aaaaaaaaaaaaaaaaaaaa";
const USER_B = "usr_bbbbbbbbbbbbbbbbbbbb";

/** Insert an identity, defaulting to a valid verified email. */
function insertIdentity(overrides: {
  userId?: string;
  type?: string;
  value?: string;
  isPrimary?: boolean;
  isVerified?: boolean;
  source?: string;
  verifiedAt?: Date | null;
}) {
  const isVerified = overrides.isVerified ?? true;
  const verifiedAt = overrides.verifiedAt !== undefined ? overrides.verifiedAt : isVerified ? new Date() : null;

  return db.sql`
    INSERT INTO user_identity (id, user_id, type, value, is_primary, is_verified, source, verified_at)
    VALUES (
      ${newId("identity")},
      ${overrides.userId ?? USER_A},
      ${overrides.type ?? "email"},
      ${overrides.value ?? `x${Bun.randomUUIDv7().slice(0, 8)}@example.com`},
      ${overrides.isPrimary ?? false},
      ${isVerified},
      ${overrides.source ?? "self"},
      ${verifiedAt}
    )
  `;
}

describe("user_identity — global handle uniqueness", () => {
  // The single most important constraint in the alias model.
  test("rejects the same handle for two different users", async () => {
    await insertIdentity({ userId: USER_A, value: "shared@example.com" });

    await expectRejection(
      () => insertIdentity({ userId: USER_B, value: "shared@example.com" }),
      "uq_identity_value",
    );
  });

  test("rejects the same phone for two different users", async () => {
    await insertIdentity({ userId: USER_A, type: "phone", value: "+919811100001" });

    await expectRejection(
      () => insertIdentity({ userId: USER_B, type: "phone", value: "+919811100001" }),
      "uq_identity_value",
    );
  });

  test("allows the same local part across different types", async () => {
    await insertIdentity({ value: "dual@example.com" });
    await insertIdentity({ type: "phone", value: "+919811100002" });
    // no rejection expected
    expect(true).toBe(true);
  });
});

describe("user_identity — exactly one primary per type", () => {
  test("rejects a second primary for the same user and type", async () => {
    const user = "usr_primary_email_test";
    await insertIdentity({ userId: user, isPrimary: true, value: "p1@example.com" });

    await expectRejection(
      () => insertIdentity({ userId: user, isPrimary: true, value: "p2@example.com" }),
      "uq_primary_per_type",
    );
  });

  test("allows one primary email and one primary phone for the same user", async () => {
    const user = "usr_primary_both_test";
    await insertIdentity({ userId: user, isPrimary: true, value: "both@example.com" });
    await insertIdentity({ userId: user, isPrimary: true, type: "phone", value: "+919811100003" });
    expect(true).toBe(true);
  });

  test("allows many non-primary identities", async () => {
    const user = "usr_many_alias_test";
    await insertIdentity({ userId: user, value: "a1@example.com" });
    await insertIdentity({ userId: user, value: "a2@example.com" });
    await insertIdentity({ userId: user, value: "a3@example.com" });
    expect(true).toBe(true);
  });
});

describe("user_identity — verification integrity", () => {
  // A half-verified row must be unrepresentable: it is the state an attacker
  // would want, since "verified" is what gates authentication.
  test("rejects is_verified = true with a null verified_at", async () => {
    await expectRejection(
      () => insertIdentity({ isVerified: true, verifiedAt: null, value: "halfv@example.com" }),
      "ck_identity_verified_at",
    );
  });

  test("rejects is_verified = false with a verified_at set", async () => {
    await expectRejection(
      () => insertIdentity({ isVerified: false, verifiedAt: new Date(), value: "halfu@example.com" }),
      "ck_identity_verified_at",
    );
  });

  test("allows an unverified identity with no verified_at", async () => {
    await insertIdentity({ isVerified: false, verifiedAt: null, value: "unverified@example.com" });
    expect(true).toBe(true);
  });
});

describe("user_identity — normalisation enforced in the schema", () => {
  // "Store the normalised form" — enforced here so a badly written import job
  // fails loudly instead of corrupting quietly.
  test("rejects a non-lowercased email", async () => {
    await expectRejection(
      () => insertIdentity({ value: "Foo@Bar.com" }),
      "ck_identity_email_normalised",
    );
  });

  test("rejects an email with surrounding whitespace", async () => {
    await expectRejection(
      () => insertIdentity({ value: " spaced@example.com " }),
      "ck_identity_email_normalised",
    );
  });

  test("rejects a bare 10-digit phone number", async () => {
    await expectRejection(
      () => insertIdentity({ type: "phone", value: "9876543210" }),
      "ck_identity_phone_e164",
    );
  });

  test("rejects a phone with spaces or dashes", async () => {
    await expectRejection(
      () => insertIdentity({ type: "phone", value: "+91 98765 43210" }),
      "ck_identity_phone_e164",
    );
  });

  test("rejects a phone with a leading zero after the plus", async () => {
    await expectRejection(
      () => insertIdentity({ type: "phone", value: "+0919876543210" }),
      "ck_identity_phone_e164",
    );
  });

  test("accepts a valid E.164 phone", async () => {
    await insertIdentity({ type: "phone", value: "+919811100004" });
    expect(true).toBe(true);
  });

  test("rejects an empty value", async () => {
    await expectRejection(() => insertIdentity({ value: "" }), "ck_identity");
  });
});

describe("user_identity — enum guards", () => {
  test("rejects an unknown identity type", async () => {
    await expectRejection(
      () => insertIdentity({ type: "fax", value: "+919811100005" }),
      "ck_identity_type",
    );
  });

  test("rejects an unknown source", async () => {
    await expectRejection(
      () => insertIdentity({ source: "guesswork", value: "src@example.com" }),
      "ck_identity_source",
    );
  });
});

describe("vendor — activation requires a verified domain", () => {
  // An active vendor with an unverified domain could assert identities it does
  // not own. Made unrepresentable so step 10 cannot forget it.
  test("rejects an active vendor with no verified domain", async () => {
    await expectRejection(
      () => db.sql`
        INSERT INTO vendor (id, name, status)
        VALUES (${newId("vendor")}, ${"Unverified Co"}, ${"active"})
      `,
      "ck_vendor_active_requires_verified_domain",
    );
  });

  test("allows an active vendor once the domain is verified", async () => {
    await db.sql`
      INSERT INTO vendor (id, name, status, domain_verified_at)
      VALUES (${newId("vendor")}, ${"Verified Co"}, ${"active"}, ${new Date()})
    `;
    expect(true).toBe(true);
  });

  test("allows a pending vendor with no verified domain", async () => {
    await db.sql`
      INSERT INTO vendor (id, name, status)
      VALUES (${newId("vendor")}, ${"Pending Co"}, ${"pending"})
    `;
    expect(true).toBe(true);
  });

  test("rejects an unknown vendor status", async () => {
    await expectRejection(
      () => db.sql`
        INSERT INTO vendor (id, name, status)
        VALUES (${newId("vendor")}, ${"Bad Status Co"}, ${"enabled"})
      `,
      "ck_vendor_status",
    );
  });

  test("rejects a duplicate vendor name", async () => {
    await db.sql`INSERT INTO vendor (id, name) VALUES (${newId("vendor")}, ${"Unique Co"})`;
    await expectRejection(
      () => db.sql`INSERT INTO vendor (id, name) VALUES (${newId("vendor")}, ${"Unique Co"})`,
      "uq_vendor_name",
    );
  });
});

describe("user_product_access — vendor scoping", () => {
  let vendorId: string;

  beforeAll(async () => {
    vendorId = newId("vendor");
    await db.sql`INSERT INTO vendor (id, name) VALUES (${vendorId}, ${"Scope Test Co"})`;
  });

  function insertAccess(role: string, vendor: string | null, status = "active", revokedAt: Date | null = null) {
    return db.sql`
      INSERT INTO user_product_access (id, user_id, product_id, role, vendor_id, status, revoked_at)
      VALUES (${newId("access")}, ${`usr_${role}_${status}`}, ${"masterclass"}, ${role},
              ${vendor}, ${status}, ${revokedAt})
    `;
  }

  // A VENDOR without a vendor_id has unbounded scope — the cross-tenant leak.
  test("rejects a VENDOR role without a vendor_id", async () => {
    await expectRejection(() => insertAccess("VENDOR", null), "ck_access_vendor_scope");
  });

  test("rejects a VENDOR_ADMIN role without a vendor_id", async () => {
    await expectRejection(() => insertAccess("VENDOR_ADMIN", null), "ck_access_vendor_scope");
  });

  // And the other direction: an ADMIN with a vendor_id implies a scoping that
  // nothing enforces.
  test("rejects a non-vendor role carrying a vendor_id", async () => {
    await expectRejection(() => insertAccess("ADMIN", vendorId), "ck_access_vendor_scope");
  });

  test("allows a VENDOR role with a vendor_id", async () => {
    await insertAccess("VENDOR", vendorId);
    expect(true).toBe(true);
  });

  test("allows a non-vendor role with no vendor_id", async () => {
    await insertAccess("CMA", null);
    expect(true).toBe(true);
  });

  test("rejects an unknown role", async () => {
    await expectRejection(() => insertAccess("SUPERUSER", null), "ck_access_role");
  });

  test("rejects an unknown product", async () => {
    await expectRejection(
      () => db.sql`
        INSERT INTO user_product_access (id, user_id, product_id, role)
        VALUES (${newId("access")}, ${"usr_p"}, ${"crm"}, ${"NORMAL"})
      `,
      "ck_access_product",
    );
  });

  // Revocation is a status change, never a DELETE — so it must be dated.
  test("rejects a revoked row with no revoked_at", async () => {
    await expectRejection(() => insertAccess("NORMAL", null, "revoked", null), "ck_access_revoked_at");
  });

  test("allows a revoked row with revoked_at", async () => {
    await insertAccess("CAIRA", null, "revoked", new Date());
    expect(true).toBe(true);
  });

  test("rejects a duplicate user/product/role triple", async () => {
    const user = "usr_dup_access";
    await db.sql`
      INSERT INTO user_product_access (id, user_id, product_id, role)
      VALUES (${newId("access")}, ${user}, ${"lms"}, ${"CPA"})
    `;
    await expectRejection(
      () => db.sql`
        INSERT INTO user_product_access (id, user_id, product_id, role)
        VALUES (${newId("access")}, ${user}, ${"lms"}, ${"CPA"})
      `,
      "uq_access_user_product_role",
    );
  });
});

describe("identity_merge_log — append only", () => {
  const logId = newId("merge");

  beforeAll(async () => {
    await db.sql`
      INSERT INTO identity_merge_log (id, survivor_user_id, merged_user_id, tier, evidence, actor)
      VALUES (${logId}, ${USER_A}, ${USER_B}, ${"B"}, ${JSON.stringify({ email: "match" })}, ${"system"})
    `;
  });

  // Convention does not survive a feature written at 2am; the trigger does.
  test("rejects UPDATE", async () => {
    await expectRejection(
      () => db.sql`UPDATE identity_merge_log SET actor = ${"tamper"} WHERE id = ${logId}`,
      "append-only",
    );
  });

  test("rejects DELETE", async () => {
    await expectRejection(
      () => db.sql`DELETE FROM identity_merge_log WHERE id = ${logId}`,
      "append-only",
    );
  });

  test("rejects an unknown tier", async () => {
    await expectRejection(
      () => db.sql`
        INSERT INTO identity_merge_log (id, survivor_user_id, merged_user_id, tier, evidence, actor)
        VALUES (${newId("merge")}, ${USER_A}, ${USER_B}, ${"F"}, ${"{}"}, ${"system"})
      `,
      "ck_merge_tier",
    );
  });

  test("rejects a merge where survivor equals merged", async () => {
    await expectRejection(
      () => db.sql`
        INSERT INTO identity_merge_log (id, survivor_user_id, merged_user_id, tier, evidence, actor)
        VALUES (${newId("merge")}, ${USER_A}, ${USER_A}, ${"A"}, ${"{}"}, ${"system"})
      `,
      "ck_merge_distinct",
    );
  });

  test("the row survives the rejected mutations", async () => {
    const rows = (await db.sql`SELECT actor FROM identity_merge_log WHERE id = ${logId}`) as {
      actor: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe("system");
  });
});

describe("outbox", () => {
  test("ix_outbox_pending exists and is partial", async () => {
    const rows = (await db.sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = ${db.schema} AND indexname = 'ix_outbox_pending'
    `) as { indexdef: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("WHERE (processed_at IS NULL)");
  });

  test("rejects negative attempts", async () => {
    await expectRejection(
      () => db.sql`
        INSERT INTO outbox (aggregate, event_type, payload, attempts)
        VALUES (${"enrolment"}, ${"created"}, ${"{}"}, ${-1})
      `,
      "ck_outbox_attempts",
    );
  });

  test("accepts a pending event", async () => {
    await db.sql`
      INSERT INTO outbox (aggregate, event_type, payload)
      VALUES (${"enrolment"}, ${"created"}, ${JSON.stringify({ courseId: "c1" })})
    `;
    const rows = (await db.sql`SELECT count(*)::int AS n FROM outbox WHERE processed_at IS NULL`) as {
      n: number;
    }[];
    expect((rows[0]?.n ?? 0) > 0).toBe(true);
  });
});

describe("schema shape", () => {
  test("creates exactly the tables this service owns", async () => {
    const rows = (await db.sql`
      SELECT tablename FROM pg_tables WHERE schemaname = ${db.schema} ORDER BY tablename
    `) as { tablename: string }[];

    expect(rows.map(r => r.tablename)).toEqual([
      "identity_merge_log",
      "outbox",
      "schema_migration",
      "user_identity",
      "user_product_access",
      "vendor",
    ]);
  });

  test("every timestamp column is timestamptz, never timestamp", async () => {
    const rows = (await db.sql`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND data_type LIKE 'timestamp%'
    `) as { table_name: string; column_name: string; data_type: string }[];

    expect(rows.length > 0).toBe(true);
    for (const row of rows) {
      expect(row.data_type).toBe("timestamp with time zone");
    }
  });

  test("no varchar columns — text only", async () => {
    const rows = (await db.sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND data_type = 'character varying'
    `) as { column_name: string }[];

    expect(rows).toEqual([]);
  });

  test("a fresh schema can be created and dropped independently", async () => {
    const tables = await withTestSchema(async other => {
      const rows = (await other.sql`
        SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = ${other.schema}
      `) as { n: number }[];
      return rows[0]?.n ?? 0;
    });
    expect(tables).toBe(6);
  });
});
