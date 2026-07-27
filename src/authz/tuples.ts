/**
 * The FGA-side interpretation of a claimed `outbox` row (AGENTS.md: "authz/
 * OpenFGA model, tuple writes, check/list wrappers"). No SQL here — `db/
 * outbox-worker.ts` owns claiming and marking rows; this file only decides
 * what an already-claimed row means to OpenFGA.
 *
 * Only `aggregate = 'vendor_access'` exists today (roadmap step 11's own
 * scope — see prompts/012, Assumption 1). A future aggregate this worker
 * doesn't understand yet must not jam the queue, so it is skipped, not
 * retried forever.
 */

import { z } from "zod";
import type { ClientWriteRequestOpts, OpenFgaClient } from "@openfga/sdk";
import { WriteRequestDeletesOnMissing, WriteRequestWritesOnDuplicate } from "@openfga/sdk";
import { VENDOR_ROLES } from "@/db/types";
import type { OutboxRow } from "@/db/types";
import { ValidationError } from "@/lib/errors";
import { log } from "@/lib/logger";

const VendorAccessPayload = z.object({
  userId: z.string(),
  vendorId: z.string(),
  role: z.enum(VENDOR_ROLES),
});

export type VendorAccessPayload = z.infer<typeof VendorAccessPayload>;

export type FgaTupleKey = { user: string; relation: string; object: string };

/** `VENDOR_ADMIN` maps to the `admin` relation; `VENDOR` to `staff` (model.fga). */
export function tupleKeyForVendorAccess(payload: VendorAccessPayload): FgaTupleKey {
  return {
    user: `user:${payload.userId}`,
    relation: payload.role === "VENDOR_ADMIN" ? "admin" : "staff",
    object: `vendor:${payload.vendorId}`,
  };
}

const WRITE_CONFLICT: ClientWriteRequestOpts = {
  conflict: { onDuplicateWrites: WriteRequestWritesOnDuplicate.Ignore },
};
const DELETE_CONFLICT: ClientWriteRequestOpts = {
  conflict: { onMissingDeletes: WriteRequestDeletesOnMissing.Ignore },
};

export type ApplyTupleClient = Pick<OpenFgaClient, "write">;

/**
 * Idempotent by construction: a repeat `granted` event for an already-written
 * tuple, or a repeat `revoked` event for an already-deleted one, is a no-op —
 * not an error that would spin `outbox.attempts` up forever (prompts/012,
 * Assumption 6).
 */
export async function applyOutboxEvent(row: OutboxRow, fgaClient: ApplyTupleClient): Promise<void> {
  if (row.aggregate !== "vendor_access") {
    log.warn("outbox_unknown_aggregate", { id: row.id.toString(), aggregate: row.aggregate });
    return;
  }

  const payload = VendorAccessPayload.parse(row.payload);
  const tuple = tupleKeyForVendorAccess(payload);

  if (row.event_type === "granted") {
    await fgaClient.write({ writes: [tuple] }, WRITE_CONFLICT);
    return;
  }
  if (row.event_type === "revoked") {
    await fgaClient.write({ deletes: [tuple] }, DELETE_CONFLICT);
    return;
  }

  throw new ValidationError(`outbox row ${row.id}: unknown event_type "${row.event_type}" for aggregate vendor_access`);
}
