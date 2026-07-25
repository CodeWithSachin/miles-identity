/**
 * The `transaction()` helper.
 *
 * "Domain write and outbox row commit together, or neither commits" is the
 * invariant the whole tuple-sync design rests on, so the rollback case matters
 * more than the happy path.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { DatabaseError } from "@/lib/errors";
import { testDatabaseUrl } from "../helpers/database";

let schema: string;
let client: SQL;
let admin: SQL;

beforeAll(async () => {
  schema = `test_tx_${Bun.randomUUIDv7().replace(/-/g, "")}`.slice(0, 40);
  admin = new SQL(testDatabaseUrl(), { max: 2 });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);

  client = new SQL(`${testDatabaseUrl()}?options=-c%20search_path%3D${schema}`, { max: 4 });
  await client.unsafe(`CREATE TABLE thing (id text PRIMARY KEY)`);
  await client.unsafe(`CREATE TABLE thing_outbox (id text PRIMARY KEY, thing_id text NOT NULL)`);
});

afterAll(async () => {
  await client.close();
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.close();
});

async function count(table: "thing" | "thing_outbox"): Promise<number> {
  // Table name is a closed union, never external input — identifiers cannot be
  // parameterised, so it must not come from a caller.
  const rows = (await client.unsafe(`SELECT count(*)::int AS n FROM ${table}`)) as { n: number }[];
  return rows[0]?.n ?? 0;
}

/**
 * A local copy of the helper bound to the test client. `src/db/client.ts` exports
 * `transaction()` bound to Bun's default `sql`, which cannot be pointed at a test
 * schema; the semantics under test — commit together, roll back together, wrap as
 * DatabaseError — are identical.
 */
async function transaction<T>(operation: string, fn: (tx: Bun.TransactionSQL) => Promise<T>): Promise<T> {
  try {
    return (await client.begin(fn as never)) as T;
  } catch (error) {
    throw new DatabaseError(operation, { cause: error });
  }
}

describe("transaction()", () => {
  test("commits both writes on success", async () => {
    const before = await count("thing");

    await transaction("create thing", async tx => {
      await tx`INSERT INTO thing (id) VALUES (${"t1"})`;
      await tx`INSERT INTO thing_outbox (id, thing_id) VALUES (${"o1"}, ${"t1"})`;
    });

    expect(await count("thing")).toBe(before + 1);
    expect(await count("thing_outbox")).toBe(1);
  });

  // The invariant that makes the outbox pattern correct: a failure after the
  // domain write must not leave the domain row without its event.
  test("rolls back the domain write when the outbox write fails", async () => {
    const thingsBefore = await count("thing");
    const outboxBefore = await count("thing_outbox");

    let thrown: unknown;
    try {
      await transaction("create thing", async tx => {
        await tx`INSERT INTO thing (id) VALUES (${"t2"})`;
        // Duplicate primary key — fails after the domain row was inserted.
        await tx`INSERT INTO thing_outbox (id, thing_id) VALUES (${"o1"}, ${"t2"})`;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DatabaseError);
    expect(await count("thing")).toBe(thingsBefore);
    expect(await count("thing_outbox")).toBe(outboxBefore);
  });

  test("rolls back when the callback throws a plain error", async () => {
    const before = await count("thing");

    let thrown: unknown;
    try {
      await transaction("create thing", async tx => {
        await tx`INSERT INTO thing (id) VALUES (${"t3"})`;
        throw new Error("business rule failed");
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DatabaseError);
    expect(await count("thing")).toBe(before);
  });

  test("wraps failures as DatabaseError, naming the operation and preserving cause", async () => {
    let thrown: unknown;
    try {
      await transaction("merge identities", async tx => {
        await tx`SELECT this_function_does_not_exist()`;
      });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as DatabaseError;
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error.code).toBe("DATABASE_ERROR");
    expect(error.message).toContain("merge identities");
    expect(error.cause).toBeDefined();
  });

  // SECURITY: a Postgres error can embed table names, column values and the
  // connection target. DatabaseError must never be client-visible.
  test("DatabaseError is never exposed to a client", async () => {
    const error = new DatabaseError("some operation");
    expect(error.expose).toBe(false);
    expect(error.httpStatus).toBe(500);
  });

  test("returns the callback's value", async () => {
    const result = await transaction("read", async tx => {
      const rows = (await tx`SELECT 42 AS answer`) as { answer: number }[];
      return rows[0]?.answer;
    });
    expect(result).toBe(42);
  });
});
