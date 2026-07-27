/**
 * Injected `listPage`/`checkRelation` — no live database, no live OpenFGA.
 */

import { test, expect, describe } from "bun:test";
import { runShadowReconciliation, type ShadowDeps } from "@/authz/shadow";
import type { VendorScopedAccessRow } from "@/db/access";

function pagedListOf(rows: VendorScopedAccessRow[]): ShadowDeps["listPage"] {
  return async (cursor, limit) => rows.filter((r) => r.id > cursor).slice(0, limit);
}

describe("runShadowReconciliation", () => {
  test("agreement is not counted as a disagreement", async () => {
    const rows: VendorScopedAccessRow[] = [{ id: "acc_1", user_id: "usr_1", vendor_id: "vnd_1", role: "VENDOR" }];
    const result = await runShadowReconciliation({
      listPage: pagedListOf(rows),
      checkRelation: async () => true,
    });

    expect(result).toEqual({ checked: 1, disagreements: 0, unavailable: 0 });
  });

  test("a false graph decision counts as a disagreement", async () => {
    const rows: VendorScopedAccessRow[] = [{ id: "acc_1", user_id: "usr_1", vendor_id: "vnd_1", role: "VENDOR_ADMIN" }];
    const result = await runShadowReconciliation({
      listPage: pagedListOf(rows),
      checkRelation: async () => false,
    });

    expect(result).toEqual({ checked: 1, disagreements: 1, unavailable: 0 });
  });

  test("an unreachable graph counts as unavailable, never as a disagreement", async () => {
    const rows: VendorScopedAccessRow[] = [{ id: "acc_1", user_id: "usr_1", vendor_id: "vnd_1", role: "VENDOR" }];
    const result = await runShadowReconciliation({
      listPage: pagedListOf(rows),
      checkRelation: async () => null,
    });

    expect(result).toEqual({ checked: 1, disagreements: 0, unavailable: 1 });
  });

  test("walks multiple pages to completion with no row visited twice", async () => {
    const rows: VendorScopedAccessRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `acc_${i}`,
      user_id: `usr_${i}`,
      vendor_id: "vnd_1",
      role: "VENDOR" as const,
    }));
    const seen: string[] = [];

    const result = await runShadowReconciliation(
      {
        listPage: pagedListOf(rows),
        checkRelation: async (user) => {
          seen.push(user);
          return true;
        },
      },
      2, // pageSize — forces 3 pages for 5 rows
    );

    expect(result).toEqual({ checked: 5, disagreements: 0, unavailable: 0 });
    expect(new Set(seen).size).toBe(5);
  });
});
