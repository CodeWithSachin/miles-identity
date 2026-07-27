/**
 * The outbox drain's `applyEvent` dispatcher — pulled out of
 * `src/jobs/outbox-worker.ts` so it can be imported by a test without also
 * triggering that file's top-level `Bun.cron(...)` registration (which would
 * start a real, minutely-firing schedule for the whole test run). `jobs/
 * outbox-worker.ts` is the only thing that imports this file outside tests.
 *
 * Dispatches by `row.aggregate`: `vendor_access` → `authz/tuples.ts` (what a
 * claimed row means to OpenFGA, roadmap step 11), `salesforce_contact_link` →
 * `integrations/salesforce.ts` (what it means to Salesforce, roadmap step 12,
 * prompts/013). Anything else is logged and skipped, not thrown — a future
 * aggregate this dispatcher doesn't know about yet must not jam the queue.
 */

import { getFgaClient } from "@/authz/client";
import { applyOutboxEvent } from "@/authz/tuples";
import { applySalesforceContactLinkEvent } from "@/integrations/salesforce";
import type { OutboxRow } from "@/db/types";
import { log } from "@/lib/logger";

export async function applyEvent(row: OutboxRow): Promise<void> {
  if (row.aggregate === "vendor_access") {
    await applyOutboxEvent(row, getFgaClient());
    return;
  }
  if (row.aggregate === "salesforce_contact_link") {
    await applySalesforceContactLinkEvent(row);
    return;
  }
  log.warn("outbox_unknown_aggregate", { id: row.id.toString(), aggregate: row.aggregate });
}
