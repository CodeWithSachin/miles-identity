/**
 * Development fixtures. Refuses to run in production.
 *
 * There is no production seed data: products, roles and statuses are CHECK-constraint
 * enums rather than rows. The only real reference data is vendors, and those are
 * created through the admin console with DNS domain verification — not seeded.
 *
 * Usage: bun run db:seed
 */

import { sql } from "bun";
import { log } from "@/lib/logger";
import { newId } from "./types";

export type SeedResult = { vendors: number; identities: number };

export async function seed(): Promise<SeedResult> {
  // A seed script that can run in production is a seed script that eventually does.
  if (Bun.env["NODE_ENV"] === "production") {
    throw new Error("refusing to seed: NODE_ENV=production");
  }

  const vendorId = newId("vendor");

  await sql.begin(async tx => {
    // 'pending' with no verified domain — the only state a new vendor may be in.
    // ck_vendor_active_requires_verified_domain rejects 'active' here, which is
    // the point: even a fixture cannot create an unverifiable active vendor.
    // ARRAY[...]::text[] rather than passing a JS array: Bun.sql does not coerce
    // an array parameter into a Postgres array literal here.
    await tx`
      INSERT INTO vendor (id, name, allowed_email_domains, status)
      VALUES (${vendorId}, ${"Dev Vendor"}, ARRAY[${"devvendor.test"}]::text[], ${"pending"})
      ON CONFLICT (name) DO NOTHING
    `;

    // A user with two verified email aliases and one verified phone, all pointing
    // at the same id — the shape step 4 resolves against. user_id is not an FK yet
    // (see 0002), so no "user" row is required.
    const userId = "usr_dev_0000000000000000";
    const now = new Date();

    const identities = [
      { type: "email", value: "dev.primary@example.com", primary: true },
      { type: "email", value: "dev.alias@example.com", primary: false },
      { type: "phone", value: "+919999900000", primary: true },
    ] as const;

    for (const identity of identities) {
      await tx`
        INSERT INTO user_identity (id, user_id, type, value, is_primary, is_verified, source, verified_at)
        VALUES (${newId("identity")}, ${userId}, ${identity.type}, ${identity.value},
                ${identity.primary}, ${true}, ${"self"}, ${now})
        ON CONFLICT (type, value) DO NOTHING
      `;
    }
  });

  const [vendorCount] = (await sql`SELECT count(*)::int AS n FROM vendor`) as { n: number }[];
  const [identityCount] = (await sql`SELECT count(*)::int AS n FROM user_identity`) as { n: number }[];

  return { vendors: vendorCount?.n ?? 0, identities: identityCount?.n ?? 0 };
}

if (import.meta.main) {
  try {
    const result = await seed();
    log.info("seed_complete", result);
    process.exit(0);
  } catch (error) {
    log.error("seed_failed", error);
    process.exit(1);
  }
}
