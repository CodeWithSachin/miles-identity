/**
 * Real schema (claim/mark/attempts are exactly the transactional behaviour a
 * mock would not catch — postgres-migrations.md), fake `applyEvent` (the
 * "true external" is OpenFGA, not Postgres — testing-and-checks.md).
 *
 * Uses its own schema-pinned `SQL` client (see tests/db/access.test.ts's
 * comment): `drainOutbox` calls `client.begin(...)` per row, and a
 * transaction can be handed a different pooled connection than the one `SET
 * search_path` was run on.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { SQL } from "bun";
import { createTestSchema, dropTestSchema, testDatabaseUrl, type TestDatabase } from "../helpers/database";
import { drainOutbox } from "@/db/outbox-worker";
import type { OutboxRow } from "@/db/types";

let raw: TestDatabase;
let client: SQL;

beforeAll(async () => {
  raw = await createTestSchema();
  client = new SQL(`${testDatabaseUrl()}?options=-c%20search_path%3D${raw.schema}`, { max: 4 });
});

afterAll(async () => {
  await client.close();
  await dropTestSchema(raw);
});

beforeEach(async () => {
  await client`DELETE FROM outbox`;
});

async function insertPending(payload: Record<string, unknown> = { userId: "usr_x" }): Promise<void> {
  await client`
    INSERT INTO outbox (aggregate, event_type, payload)
    VALUES ('vendor_access', 'granted', ${payload})
  `;
}

describe("drainOutbox", () => {
  test("claims a pending row, applies it, and marks processed_at", async () => {
    await insertPending();
    const applied: OutboxRow[] = [];

    const result = await drainOutbox(async (row) => void applied.push(row), { client });

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(applied).toHaveLength(1);

    const rows = (await client`SELECT processed_at FROM outbox`) as { processed_at: Date | null }[];
    expect(rows[0]?.processed_at).not.toBeNull();
  });

  test("a row whose applyEvent throws stays unprocessed, with attempts incremented and last_error set", async () => {
    await insertPending();

    const result = await drainOutbox(
      async () => {
        throw new Error("fga unreachable");
      },
      { client },
    );

    expect(result).toEqual({ processed: 0, failed: 1 });

    const rows = (await client`SELECT processed_at, attempts, last_error FROM outbox`) as {
      processed_at: Date | null;
      attempts: number;
      last_error: string | null;
    }[];
    expect(rows[0]?.processed_at).toBeNull();
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.last_error).toBe("fga unreachable");
  });

  test("a failed row is retried on the next drain rather than lost", async () => {
    await insertPending();
    let calls = 0;

    const flaky = async (): Promise<void> => {
      calls++;
      if (calls === 1) throw new Error("first attempt fails");
    };

    const first = await drainOutbox(flaky, { client });
    expect(first).toEqual({ processed: 0, failed: 1 });

    const second = await drainOutbox(flaky, { client });
    expect(second).toEqual({ processed: 1, failed: 0 });
    expect(calls).toBe(2);
  });

  test("maxRows processes exactly that many rows and leaves the rest pending", async () => {
    await insertPending({ userId: "usr_a" });
    await insertPending({ userId: "usr_b" });
    await insertPending({ userId: "usr_c" });

    const result = await drainOutbox(async () => {}, { client, maxRows: 1 });
    expect(result).toEqual({ processed: 1, failed: 0 });

    const pending = (await client`SELECT id FROM outbox WHERE processed_at IS NULL`) as { id: string }[];
    expect(pending).toHaveLength(2);
  });

  test("already-processed rows are never re-claimed", async () => {
    await insertPending();
    await drainOutbox(async () => {}, { client });

    const second = await drainOutbox(async () => {
      throw new Error("must not be called on an already-processed row");
    }, { client });

    expect(second).toEqual({ processed: 0, failed: 0 });
  });
});
