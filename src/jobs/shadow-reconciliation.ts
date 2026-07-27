/**
 * Schedules shadow-mode reconciliation (`src/authz/shadow.ts`). Thin wiring
 * only, same reasoning as `src/jobs/outbox-worker.ts`.
 *
 * Daily — the disagreement count is reviewed by a human, not consumed
 * automatically (openfga-authz.md rule 8: "flip enforcement only after the
 * disagreement rate is zero for a week").
 */

import { runShadowReconciliation } from "@/authz/shadow";
import { log } from "@/lib/logger";

Bun.cron("0 3 * * *", async () => {
  try {
    const result = await runShadowReconciliation();
    log.info("authz_shadow_reconciliation_scheduled", result);
  } catch (error) {
    log.error("authz_shadow_reconciliation_failed", error);
  }
});
