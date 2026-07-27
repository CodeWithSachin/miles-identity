/**
 * Schedules the outbox drain. Thin wiring only — the logic lives in
 * `src/db/outbox-worker.ts` (claim/mark) and `src/authz/tuples.ts` (what a
 * claimed row means to OpenFGA); this file only composes the two and
 * registers the schedule (testing-and-checks.md: "schedule in jobs/, logic
 * elsewhere, test the logic" — `Bun.cron` itself is not unit-testable).
 *
 * Every minute (prompts/012, Assumption 7) — the finest granularity `Bun.cron`
 * supports, far ahead of current volume (vendor grant/revoke only).
 */

import { getFgaClient } from "@/authz/client";
import { applyOutboxEvent } from "@/authz/tuples";
import { drainOutbox } from "@/db/outbox-worker";
import { log } from "@/lib/logger";

Bun.cron("* * * * *", async () => {
  try {
    const result = await drainOutbox((row) => applyOutboxEvent(row, getFgaClient()));
    if (result.processed > 0 || result.failed > 0) {
      log.info("outbox_drain_complete", result);
    }
  } catch (error) {
    log.error("outbox_drain_failed", error);
  }
});
