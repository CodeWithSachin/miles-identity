/**
 * `vendor` table read/write helpers against a real disposable schema — the
 * re-registration reset and the disabled-vendor activation guard are exactly
 * the kind of behaviour a mock would not catch (.agents/skills/postgres-migrations.md).
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createTestSchema, dropTestSchema, type TestDatabase } from "../helpers/database";
import {
  activateVendor,
  createVendor,
  disableVendorRow,
  getVendorById,
  getVendorBySsoProviderId,
  setVendorSsoProvider,
} from "@/db/vendor";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestSchema();
});

afterAll(async () => {
  await dropTestSchema(db);
});

describe("createVendor", () => {
  test("stores a single-element allowed_email_domains and starts pending", async () => {
    const vendor = await createVendor({ name: "Acme Prep", domain: "acmeprep.example" }, db.sql);
    expect(vendor.allowed_email_domains).toEqual(["acmeprep.example"]);
    expect(vendor.status).toBe("pending");
    expect(vendor.sso_provider_id).toBeNull();
    expect(vendor.domain_verified_at).toBeNull();
  });
});

describe("getVendorById / getVendorBySsoProviderId", () => {
  test("finds a vendor by id and by its registered provider", async () => {
    const vendor = await createVendor({ name: "Beta Prep", domain: "betaprep.example" }, db.sql);
    await setVendorSsoProvider(vendor.id, "ssp_beta", db.sql);

    expect((await getVendorById(vendor.id, db.sql))?.id).toBe(vendor.id);
    expect((await getVendorBySsoProviderId("ssp_beta", db.sql))?.id).toBe(vendor.id);
    expect(await getVendorBySsoProviderId("ssp_does_not_exist", db.sql)).toBeNull();
  });
});

describe("setVendorSsoProvider", () => {
  test("resets domain_verified_at and status to pending, even if previously active", async () => {
    const vendor = await createVendor({ name: "Gamma Prep", domain: "gammaprep.example" }, db.sql);
    await setVendorSsoProvider(vendor.id, "ssp_gamma_1", db.sql);
    const activated = await activateVendor(vendor.id, db.sql);
    expect(activated?.status).toBe("active");

    // Re-registration (e.g. after a disable) must not carry over stale verification.
    const reregistered = await setVendorSsoProvider(vendor.id, "ssp_gamma_2", db.sql);
    expect(reregistered?.status).toBe("pending");
    expect(reregistered?.domain_verified_at).toBeNull();
    expect(reregistered?.sso_provider_id).toBe("ssp_gamma_2");
  });
});

describe("activateVendor", () => {
  test("refuses to resurrect a disabled vendor", async () => {
    const vendor = await createVendor({ name: "Delta Prep", domain: "deltaprep.example" }, db.sql);
    await setVendorSsoProvider(vendor.id, "ssp_delta", db.sql);
    await disableVendorRow(vendor.id, db.sql);

    const result = await activateVendor(vendor.id, db.sql);
    expect(result).toBeNull();

    const row = await getVendorById(vendor.id, db.sql);
    expect(row?.status).toBe("disabled");
  });
});

describe("disableVendorRow", () => {
  test("clears sso_provider_id and flips status to disabled", async () => {
    const vendor = await createVendor({ name: "Epsilon Prep", domain: "epsilonprep.example" }, db.sql);
    await setVendorSsoProvider(vendor.id, "ssp_epsilon", db.sql);

    const disabled = await disableVendorRow(vendor.id, db.sql);
    expect(disabled?.status).toBe("disabled");
    expect(disabled?.sso_provider_id).toBeNull();
  });
});
