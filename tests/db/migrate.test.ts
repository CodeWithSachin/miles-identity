/**
 * Migration runner behaviour.
 *
 * `discoverMigrations` is pure and testable directly. The apply path is exercised
 * against a real database via a temporary migrations directory, so "rolls back on
 * failure" is a real transaction rollback rather than a mocked one.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { SQL } from "bun";
import { discoverMigrations, migrate as runMigrate } from "@/db/migrate";
import { MigrationError } from "@/lib/errors";
import { testDatabaseUrl } from "../helpers/database";

const REAL_MIGRATIONS = new URL("../../src/db/migrations/", import.meta.url).pathname;
const BETTER_AUTH_SCHEMA = new URL("../../src/db/better-auth-schema.sql", import.meta.url).pathname;

const tempDirs: string[] = [];
let dirCounter = 0;

async function makeMigrationDir(files: Record<string, string>): Promise<string> {
  // A UUIDv7 prefix is a timestamp, so two calls in the same millisecond share
  // their leading characters. Use the full uuid plus a counter, or two "unique"
  // directories silently become one and the second write overwrites the first.
  const dir = `/tmp/mi-migrations-${Bun.randomUUIDv7()}-${dirCounter++}/`;
  for (const [name, body] of Object.entries(files)) {
    await Bun.write(`${dir}${name}`, body);
  }
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
  }
});

describe("discoverMigrations", () => {
  test("finds the real migrations in filename order", async () => {
    const migrations = await discoverMigrations(REAL_MIGRATIONS);

    expect(migrations.map(m => m.version)).toEqual(["0001", "0002", "0003", "0004", "0005", "0006", "0007"]);
    expect(migrations[0]?.name).toBe("0001_schema_migration.sql");
    expect(migrations[6]?.name).toBe("0007_add_user_foreign_keys.sql");
  });

  test("computes a stable sha256 checksum", async () => {
    const first = await discoverMigrations(REAL_MIGRATIONS);
    const second = await discoverMigrations(REAL_MIGRATIONS);

    expect(first[0]?.checksum).toBe(second[0]?.checksum as string);
    expect(first[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different content yields a different checksum", async () => {
    const a = await makeMigrationDir({ "0001_a.sql": "SELECT 1;" });
    const b = await makeMigrationDir({ "0001_a.sql": "SELECT 2;" });

    const [ma] = await discoverMigrations(a);
    const [mb] = await discoverMigrations(b);
    expect(ma?.checksum).not.toBe(mb?.checksum as string);
  });

  // Negative — two files claiming the same version means apply order is undefined.
  test("rejects duplicate version prefixes", async () => {
    const dir = await makeMigrationDir({
      "0001_first.sql": "SELECT 1;",
      "0001_also_first.sql": "SELECT 2;",
    });

    let thrown: unknown;
    try {
      await discoverMigrations(dir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MigrationError);
    expect((thrown as MigrationError).message).toContain("duplicate migration version 0001");
  });

  test("ignores files that are not NNNN_*.sql", async () => {
    const dir = await makeMigrationDir({
      "0001_real.sql": "SELECT 1;",
      "README.md": "not a migration",
      "notes.sql": "SELECT 2;",
      "12_short.sql": "SELECT 3;",
    });

    const migrations = await discoverMigrations(dir);
    expect(migrations.map(m => m.name)).toEqual(["0001_real.sql"]);
  });

  test("returns an empty list for a directory with no migrations", async () => {
    const dir = await makeMigrationDir({ "README.md": "nothing here" });
    expect(await discoverMigrations(dir)).toEqual([]);
  });
});

/**
 * Apply-path tests. These call the REAL `migrate()` against a disposable schema
 * by injecting a client whose search_path points there — so what is asserted is
 * the runner's own behaviour, not a reimplementation of it.
 */
describe("migrate()", () => {
  async function withSchema<T>(
    fn: (ctx: { client: SQL; schema: string; migrate: typeof runMigrate }) => Promise<T>,
  ): Promise<T> {
    const schema = `test_${Bun.randomUUIDv7().replace(/-/g, "")}`.slice(0, 40);
    const admin = new SQL(testDatabaseUrl(), { max: 2 });
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);

    // Better Auth's tables must exist before our migration 0007 adds FKs to "user".
    // Applied via `admin`, deliberately NOT via `client`: `client`'s first statement
    // must be the migrate runner's `pg_advisory_lock` so the lock and its unlock land
    // on the same pooled connection. Warming `client` with the schema first can split
    // them across connections and leak the lock into the next test.
    await admin.unsafe(`SET search_path TO "${schema}"; ${await Bun.file(BETTER_AUTH_SCHEMA).text()}`);

    // A dedicated client pinned to the schema. `options` on the connection string
    // sets search_path for every connection in this pool, including new ones.
    //
    // max: 1 is deliberate. The runner takes a SESSION-level pg_advisory_lock and
    // releases it in a finally; on a multi-connection pool the lock and unlock can
    // land on different connections, leaking the lock for the life of the process.
    // The one-shot `db:migrate` process is immune (it exits immediately), but this
    // long-lived test process is not — a single connection guarantees they pair up.
    const client = new SQL(`${testDatabaseUrl()}?options=-c%20search_path%3D${schema}`, { max: 1 });

    try {
      return await fn({ client, schema, migrate: runMigrate });
    } finally {
      await client.close();
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.close();
    }
  }

  test("applies every migration and records each version", async () => {
    await withSchema(async ({ client, schema }) => {
      const result = await runMigrate({ client, dir: REAL_MIGRATIONS });

      expect(result.applied).toHaveLength(7);
      expect(result.skipped).toHaveLength(0);

      const rows = (await client`SELECT version FROM schema_migration ORDER BY version`) as {
        version: string;
      }[];
      expect(rows.map(r => r.version)).toEqual(["0001", "0002", "0003", "0004", "0005", "0006", "0007"]);

      // Excludes the Better-Auth-owned tables the harness seeds — this asserts what
      // OUR runner created.
      const tables = (await client`
        SELECT tablename FROM pg_tables
        WHERE schemaname = ${schema} AND tablename NOT IN ('user', 'session', 'account', 'jwks', 'oauthClient', 'oauthRefreshToken', 'oauthAccessToken', 'oauthConsent')
        ORDER BY tablename
      `) as { tablename: string }[];
      expect(tables.map(t => t.tablename)).toEqual([
        "identity_merge_log",
        "outbox",
        "schema_migration",
        "user_identity",
        "user_product_access",
        "vendor",
      ]);
    });
  });

  test("is idempotent — a second run applies nothing", async () => {
    await withSchema(async ({ client }) => {
      await runMigrate({ client, dir: REAL_MIGRATIONS });
      const second = await runMigrate({ client, dir: REAL_MIGRATIONS });

      expect(second.applied).toEqual([]);
      expect(second.skipped).toHaveLength(7);

      const rows = (await client`SELECT count(*)::int AS n FROM schema_migration`) as { n: number }[];
      expect(rows[0]?.n).toBe(7);
    });
  });

  test("--dry-run reports pending without applying", async () => {
    await withSchema(async ({ client, schema }) => {
      const dry = await runMigrate({ client, dir: REAL_MIGRATIONS, dryRun: true });

      expect(dry.pending).toHaveLength(7);
      expect(dry.applied).toEqual([]);

      // 0001 is IF NOT EXISTS and is applied to read state, so only the ledger exists
      // among OUR tables (the harness-seeded Better Auth tables are excluded).
      const tables = (await client`
        SELECT tablename FROM pg_tables
        WHERE schemaname = ${schema} AND tablename NOT IN ('user', 'session', 'account', 'jwks', 'oauthClient', 'oauthRefreshToken', 'oauthAccessToken', 'oauthConsent')
      `) as { tablename: string }[];
      expect(tables.map(t => t.tablename)).toEqual(["schema_migration"]);
    });
  });

  test("dry run after a real run reports nothing pending", async () => {
    await withSchema(async ({ client }) => {
      await runMigrate({ client, dir: REAL_MIGRATIONS });
      const dry = await runMigrate({ client, dir: REAL_MIGRATIONS, dryRun: true });
      expect(dry.pending).toEqual([]);
    });
  });

  // Negative — forward-only means an applied file is immutable.
  test("refuses to run when an applied migration file has changed", async () => {
    const dir = await makeMigrationDir({
      "0001_schema_migration.sql": await Bun.file(`${REAL_MIGRATIONS}0001_schema_migration.sql`).text(),
      "0002_thing.sql": "CREATE TABLE thing (id text PRIMARY KEY);",
    });

    await withSchema(async ({ client }) => {
      await runMigrate({ client, dir });

      // Edit the already-applied file.
      await Bun.write(`${dir}0002_thing.sql`, "CREATE TABLE thing (id text PRIMARY KEY); -- edited");

      let thrown: unknown;
      try {
        await runMigrate({ client, dir });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(MigrationError);
      expect((thrown as MigrationError).migration).toBe("0002_thing.sql");
      expect((thrown as MigrationError).message).toContain("Forward-only");
    });
  });

  // Negative — the property that makes a failed deploy safe.
  test("rolls back fully when a migration fails: no DDL, no ledger row", async () => {
    const dir = await makeMigrationDir({
      "0001_schema_migration.sql": await Bun.file(`${REAL_MIGRATIONS}0001_schema_migration.sql`).text(),
      "0002_broken.sql":
        "CREATE TABLE good_one (id text PRIMARY KEY); SELECT this_function_does_not_exist();",
    });

    await withSchema(async ({ client, schema }) => {
      let failed = false;
      try {
        await runMigrate({ client, dir });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);

      const tables = (await client`
        SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = ${schema} AND tablename = 'good_one'
      `) as { n: number }[];
      expect(tables[0]?.n).toBe(0); // the CREATE TABLE rolled back

      const ledger = (await client`
        SELECT count(*)::int AS n FROM schema_migration WHERE version = '0002'
      `) as { n: number }[];
      expect(ledger[0]?.n).toBe(0); // and nothing claims it succeeded
    });
  });

  test("releases the advisory lock even when a migration fails", async () => {
    const dir = await makeMigrationDir({
      "0001_schema_migration.sql": await Bun.file(`${REAL_MIGRATIONS}0001_schema_migration.sql`).text(),
      "0002_broken.sql": "SELECT this_function_does_not_exist();",
    });

    await withSchema(async ({ client }) => {
      try {
        await runMigrate({ client, dir });
      } catch {
        /* expected */
      }

      // If the lock leaked, a fresh session could not take it.
      const other = new SQL(testDatabaseUrl(), { max: 1 });
      try {
        const got = (await other`SELECT pg_try_advisory_lock(4827301556) AS got`) as { got: boolean }[];
        expect(got[0]?.got).toBe(true);
        await other`SELECT pg_advisory_unlock(4827301556)`;
      } finally {
        await other.close();
      }
    });
  });

  test("throws when migration 0001 is absent", async () => {
    const dir = await makeMigrationDir({ "0002_orphan.sql": "SELECT 1;" });

    await withSchema(async ({ client }) => {
      let thrown: unknown;
      try {
        await runMigrate({ client, dir });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MigrationError);
      expect((thrown as MigrationError).message).toContain("0001");
    });
  });

  test("throws when there are no migrations at all", async () => {
    const dir = await makeMigrationDir({ "README.md": "empty" });

    let thrown: unknown;
    try {
      await runMigrate({ client: new SQL(testDatabaseUrl(), { max: 1 }), dir });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationError);
    expect((thrown as MigrationError).message).toContain("no migrations found");
  });

  test("pg_advisory_lock serialises two runners", async () => {
    const key = 4_827_301_556;
    const a = new SQL(testDatabaseUrl(), { max: 2 });
    const b = new SQL(testDatabaseUrl(), { max: 2 });

    try {
      await a`SELECT pg_advisory_lock(${key})`;
      const contended = (await b`SELECT pg_try_advisory_lock(${key}) AS got`) as { got: boolean }[];
      expect(contended[0]?.got).toBe(false);

      await a`SELECT pg_advisory_unlock(${key})`;
      const afterRelease = (await b`SELECT pg_try_advisory_lock(${key}) AS got`) as { got: boolean }[];
      expect(afterRelease[0]?.got).toBe(true);
      await b`SELECT pg_advisory_unlock(${key})`;
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("migration file hygiene", () => {
  test("no migration contains a destructive statement", async () => {
    const migrations = await discoverMigrations(REAL_MIGRATIONS);

    for (const migration of migrations) {
      const body = migration.sqlText.toUpperCase();
      expect(body).not.toContain("DROP TABLE");
      expect(body).not.toContain("DROP COLUMN");
      expect(body).not.toContain("TRUNCATE");
      expect(body).not.toMatch(/\bDELETE FROM\b/);
    }
  });

  test("no migration uses timestamp without time zone", async () => {
    const migrations = await discoverMigrations(REAL_MIGRATIONS);

    for (const migration of migrations) {
      // `timestamptz` is fine; a bare `timestamp ` column type is not.
      expect(migration.sqlText).not.toMatch(/\btimestamp\s+(NOT|NULL|,|\))/i);
    }
  });

  test("no migration uses varchar", async () => {
    const migrations = await discoverMigrations(REAL_MIGRATIONS);
    for (const migration of migrations) {
      expect(migration.sqlText.toLowerCase()).not.toContain("varchar");
    }
  });

  // SECURITY: migration output must never carry the connection target.
  test("no migration file embeds a connection string", async () => {
    const migrations = await discoverMigrations(REAL_MIGRATIONS);
    for (const migration of migrations) {
      expect(migration.sqlText).not.toContain("postgres://");
      expect(migration.sqlText).not.toContain("postgresql://");
    }
  });
});
