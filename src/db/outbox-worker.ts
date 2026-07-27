/**
 * Drains the `outbox` table (migration 0006). SQL only — no `@openfga/sdk`
 * import here (AGENTS.md: db/ owns the outbox worker, authz/ owns the FGA
 * calls). The caller injects `applyEvent`, which is what actually talks to
 * OpenFGA; this file only claims rows, calls it, and records the outcome.
 *
 * Claims with `FOR UPDATE SKIP LOCKED` so multiple running instances never
 * both process the same row (AGENTS.md data model note on `outbox`).
 */

import { sql, type SQL } from "bun";
import type { OutboxRow } from "@/db/types";
import { log } from "@/lib/logger";

export type ApplyOutboxEvent = (row: OutboxRow) => Promise<void>;

type ClaimOutcome = { status: "processed" | "failed"; id: OutboxRow["id"] } | { status: "empty" };

/**
 * One row, one transaction: the row lock (`FOR UPDATE SKIP LOCKED`) is held
 * for exactly as long as this transaction is open, which also spans the
 * `applyEvent` call — acceptable at the volume this worker handles today
 * (vendor grant/revoke only), and it is what makes "claim, apply, mark" one
 * atomic step instead of three that could interleave with another instance.
 *
 * `excludeIds` skips rows this same `drainOutbox` call has already touched —
 * a row left `processed_at IS NULL` by a failed attempt is still "pending"
 * and, without this, would be re-claimed (and re-attempted) on every
 * remaining iteration of the same drain instead of just once, starving every
 * other pending row and turning one bad tuple into up to `maxRows` retries
 * in a single tick.
 */
async function claimAndProcessOne(applyEvent: ApplyOutboxEvent, client: SQL, excludeIds: bigint[]): Promise<ClaimOutcome> {
  return (await client.begin(async (tx) => {
    const rows = (await tx`
      SELECT * FROM outbox
      WHERE processed_at IS NULL AND id != ALL(${client.array(excludeIds, "BIGINT")})
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `) as OutboxRow[];
    const row = rows[0];
    if (!row) return { status: "empty" };

    try {
      await applyEvent(row);
      await tx`UPDATE outbox SET processed_at = now() WHERE id = ${row.id}`;
      return { status: "processed", id: row.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await tx`
        UPDATE outbox SET attempts = attempts + 1, last_error = ${message}
        WHERE id = ${row.id}
      `;
      return { status: "failed", id: row.id };
    }
  })) as ClaimOutcome;
}

export type DrainOutboxResult = { processed: number; failed: number };

/**
 * Drains up to `maxRows` distinct pending rows, one claimed transaction at a
 * time, stopping early once the queue is empty. Each row is attempted at
 * most once per call — a row whose `applyEvent` throws is logged and left
 * for the *next* drain (its `attempts`/`last_error` were already recorded
 * above); one bad row must not stop the whole batch, nor spin this call's
 * entire budget on itself.
 */
export async function drainOutbox(
  applyEvent: ApplyOutboxEvent,
  opts: { maxRows?: number; client?: SQL } = {},
): Promise<DrainOutboxResult> {
  const maxRows = opts.maxRows ?? 100;
  const client = opts.client ?? sql;

  let processed = 0;
  let failed = 0;
  const failedIds: bigint[] = [];

  for (let i = 0; i < maxRows; i++) {
    const outcome = await claimAndProcessOne(applyEvent, client, failedIds);
    if (outcome.status === "empty") break;
    if (outcome.status === "processed") processed++;
    if (outcome.status === "failed") {
      failed++;
      failedIds.push(outcome.id);
      log.warn("outbox_row_failed", { id: outcome.id.toString() });
    }
  }

  return { processed, failed };
}
