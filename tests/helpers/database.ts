/**
 * Disposable-schema harness.
 *
 * Real Postgres, per .agents/skills/testing-and-checks.md — a mocked database does
 * not reject a duplicate key, and the constraint is the thing under test.
 *
 * Each run gets its own schema, so suites cannot see each other's rows and a
 * failed run cannot poison the next one.
 */

import { SQL } from "bun";
import { discoverMigrations } from "@/db/migrate";

const MIGRATIONS_DIR = new URL("../../src/db/migrations/", import.meta.url).pathname;

/** Identifiers cannot be parameterised, so the generated name is validated. */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

export type TestDatabase = {
  sql: SQL;
  schema: string;
};

/**
 * Captured ONCE at module load, deliberately.
 *
 * Other suites mutate `Bun.env.DATABASE_URL` to point at an unroutable port in
 * order to test the degraded path. Reading it lazily here would make the database
 * suites depend on which file ran first — a genuinely nasty ordering dependency
 * that looked like a Postgres fault when it first appeared.
 */
const TEST_DATABASE_URL: string =
  Bun.env["TEST_DATABASE_URL"] ?? Bun.env["DATABASE_URL"] ?? "postgres://postgres@127.0.0.1:5432/postgres";

export function testDatabaseUrl(): string {
  return TEST_DATABASE_URL;
}

function newSchemaName(): string {
  const name = `test_${Bun.randomUUIDv7().replace(/-/g, "").slice(0, 20)}`;
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`generated schema name is not a safe identifier: ${name}`);
  }
  return name;
}

/**
 * Apply every migration to a fresh schema.
 *
 * The runner in `src/db/migrate.ts` uses Bun's default `sql` client, which we
 * cannot point at a custom `search_path`. So the harness applies the same
 * migration files through its own client instead. Ordering and content are
 * shared with the runner via `discoverMigrations()`, so the tests exercise the
 * real SQL — `migrate.test.ts` covers the runner's own behaviour separately.
 */
export async function createTestSchema(): Promise<TestDatabase> {
  const schema = newSchemaName();
  const client = new SQL(testDatabaseUrl(), { max: 4 });

  await client.unsafe(`CREATE SCHEMA "${schema}"`);
  await client.unsafe(`SET search_path TO "${schema}"`);

  const migrations = await discoverMigrations(MIGRATIONS_DIR);
  for (const migration of migrations) {
    await client.unsafe(`SET search_path TO "${schema}"; ${migration.sqlText}`);
  }

  return { sql: client, schema };
}

export async function dropTestSchema(db: TestDatabase): Promise<void> {
  try {
    await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);
  } finally {
    await db.sql.close();
  }
}

/** Run a body against a disposable schema, dropping it whatever happens. */
export async function withTestSchema<T>(fn: (db: TestDatabase) => Promise<T>): Promise<T> {
  const db = await createTestSchema();
  try {
    return await fn(db);
  } finally {
    await dropTestSchema(db);
  }
}

/**
 * Assert a write is rejected by the database, and that the rejection mentions the
 * expected constraint. Asserting the constraint name matters: a test that merely
 * expects "some error" passes when the row is rejected for the wrong reason.
 */
export async function expectRejection(
  fn: () => Promise<unknown>,
  constraintFragment: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }

  if (thrown === undefined) {
    throw new Error(`expected a rejection mentioning "${constraintFragment}", but the write succeeded`);
  }

  const message = thrown instanceof Error ? `${thrown.message}` : String(thrown);
  if (!message.toLowerCase().includes(constraintFragment.toLowerCase())) {
    throw new Error(`expected rejection to mention "${constraintFragment}", got: ${message}`);
  }
}
