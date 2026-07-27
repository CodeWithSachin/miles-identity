/**
 * Schedules the outbox drain. Thin wiring only — dispatch-by-aggregate logic
 * lives in `src/jobs/outbox-dispatch.ts` (kept separate specifically so it is
 * importable by a test without also triggering the `Bun.cron` registration
 * below), claim/mark lives in `src/db/outbox-worker.ts` (testing-and-checks.md:
 * "schedule in jobs/, logic elsewhere, test the logic" — `Bun.cron` itself is
 * not unit-testable).
 *
 * Every minute (prompts/012, Assumption 7) — the finest granularity `Bun.cron`
 * supports, far ahead of current volume.
 */

import { applyEvent } from "@/jobs/outbox-dispatch";
import { drainOutbox } from "@/db/outbox-worker";
import { log } from "@/lib/logger";

Bun.cron("* * * * *", async () => {
  try {
    const result = await drainOutbox(applyEvent);
    if (result.processed > 0 || result.failed > 0) {
      log.info("outbox_drain_complete", result);
    }
  } catch (error) {
    log.error("outbox_drain_failed", error);
  }
});
