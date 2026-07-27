/**
 * Pure logic + an injected fake FGA client (mocking the true external, per
 * testing-and-checks.md) — no live database, no live OpenFGA.
 */

import { test, expect, describe, mock } from "bun:test";
import { WriteRequestDeletesOnMissing, WriteRequestWritesOnDuplicate } from "@openfga/sdk";
import { applyOutboxEvent, tupleKeyForVendorAccess, type ApplyTupleClient } from "@/authz/tuples";
import type { OutboxRow } from "@/db/types";

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 1n,
    aggregate: "vendor_access",
    event_type: "granted",
    payload: { userId: "usr_1", vendorId: "vnd_1", role: "VENDOR" },
    attempts: 0,
    last_error: null,
    created_at: new Date(),
    processed_at: null,
    ...overrides,
  };
}

describe("tupleKeyForVendorAccess", () => {
  test("VENDOR_ADMIN maps to the admin relation", () => {
    expect(tupleKeyForVendorAccess({ userId: "usr_1", vendorId: "vnd_1", role: "VENDOR_ADMIN" })).toEqual({
      user: "user:usr_1",
      relation: "admin",
      object: "vendor:vnd_1",
    });
  });

  test("VENDOR maps to the staff relation", () => {
    expect(tupleKeyForVendorAccess({ userId: "usr_1", vendorId: "vnd_1", role: "VENDOR" })).toEqual({
      user: "user:usr_1",
      relation: "staff",
      object: "vendor:vnd_1",
    });
  });
});

describe("applyOutboxEvent", () => {
  test("granted writes the tuple, ignoring a duplicate write", async () => {
    const write = mock<ApplyTupleClient["write"]>(async () => ({ writes: [], deletes: [] }));
    const fga: ApplyTupleClient = { write };

    await applyOutboxEvent(row({ event_type: "granted" }), fga);

    expect(write).toHaveBeenCalledTimes(1);
    const [body, opts] = write.mock.calls[0]!;
    expect(body).toEqual({ writes: [{ user: "user:usr_1", relation: "staff", object: "vendor:vnd_1" }] });
    expect(opts).toEqual({ conflict: { onDuplicateWrites: WriteRequestWritesOnDuplicate.Ignore } });
  });

  test("revoked deletes the tuple, ignoring an already-missing tuple", async () => {
    const write = mock<ApplyTupleClient["write"]>(async () => ({ writes: [], deletes: [] }));
    const fga: ApplyTupleClient = { write };

    await applyOutboxEvent(row({ event_type: "revoked" }), fga);

    expect(write).toHaveBeenCalledTimes(1);
    const [body, opts] = write.mock.calls[0]!;
    expect(body).toEqual({ deletes: [{ user: "user:usr_1", relation: "staff", object: "vendor:vnd_1" }] });
    expect(opts).toEqual({ conflict: { onMissingDeletes: WriteRequestDeletesOnMissing.Ignore } });
  });

  test("an unknown aggregate is skipped: no FGA call, no throw", async () => {
    const write = mock<ApplyTupleClient["write"]>(async () => ({ writes: [], deletes: [] }));
    const fga: ApplyTupleClient = { write };

    await applyOutboxEvent(row({ aggregate: "something_future" }), fga);

    expect(write).not.toHaveBeenCalled();
  });

  test("an unknown event_type throws, so the row is retried rather than silently dropped", async () => {
    const write = mock<ApplyTupleClient["write"]>(async () => ({ writes: [], deletes: [] }));
    const fga: ApplyTupleClient = { write };

    await expect(applyOutboxEvent(row({ event_type: "renamed" }), fga)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});
