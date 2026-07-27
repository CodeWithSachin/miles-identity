/**
 * Shadow mode (openfga-authz.md rule 8 / roadmap step 11): the graph decides
 * nothing yet — RBAC (`user_product_access`) is and stays the only thing
 * enforced anywhere in this codebase. This walks every active, vendor-scoped
 * access row and logs where OpenFGA doesn't (yet) agree, so the disagreement
 * rate is a real, reviewable number before enforcement ever flips.
 *
 * Runs off the request path entirely, on a schedule (`src/jobs/
 * shadow-reconciliation.ts`) — never inline on a request, and never on the
 * login path (prompts/012, Assumption 4).
 *
 * One-directional by design (prompts/012, Assumption 5): this confirms every
 * RBAC-granted vendor relation is also present in the graph — the direction
 * that would lock someone out if enforcement flipped today. The inverse
 * ("does the graph grant anything RBAC didn't") is covered by the model's own
 * negative tests (`model.fga.yaml`), not by this repo's data.
 */

import { checkRelation as defaultCheckRelation } from "@/authz/client";
import { listActiveVendorScopedAccess, type VendorScopedAccessRow } from "@/db/access";
import { log } from "@/lib/logger";

export type ShadowDeps = {
  listPage: (cursor: string, limit: number) => Promise<VendorScopedAccessRow[]>;
  checkRelation: (user: string, relation: string, object: string) => Promise<boolean | null>;
};

const defaultDeps: ShadowDeps = {
  listPage: listActiveVendorScopedAccess,
  checkRelation: defaultCheckRelation,
};

export type ShadowReconciliationResult = { checked: number; disagreements: number; unavailable: number };

export async function runShadowReconciliation(
  deps: ShadowDeps = defaultDeps,
  pageSize = 500,
): Promise<ShadowReconciliationResult> {
  let cursor = "";
  let checked = 0;
  let disagreements = 0;
  let unavailable = 0;

  for (;;) {
    const page = await deps.listPage(cursor, pageSize);
    if (page.length === 0) break;

    for (const row of page) {
      const relation = row.role === "VENDOR_ADMIN" ? "admin" : "staff";
      const graphDecision = await deps.checkRelation(`user:${row.user_id}`, relation, `vendor:${row.vendor_id}`);
      checked++;

      if (graphDecision === null) {
        unavailable++;
        log.warn("authz_shadow_unavailable", { userId: row.user_id, vendorId: row.vendor_id, role: row.role });
      } else if (graphDecision === false) {
        disagreements++;
        log.warn("authz_shadow_disagreement", {
          userId: row.user_id,
          vendorId: row.vendor_id,
          role: row.role,
          rbacDecision: true,
          graphDecision: false,
        });
      }

      cursor = row.id;
    }
  }

  const result = { checked, disagreements, unavailable };
  log.info("authz_shadow_reconciliation_complete", result);
  return result;
}
