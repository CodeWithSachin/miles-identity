/**
 * Forward-only migration runner for the tables Miles Identity owns.
 *
 * Not a migration framework — no node-pg-migrate, Flyway, Atlas or Liquibase. The
 * two behaviours those bundle that actually matter here are checksum verification
 * and an advisory lock, and both are a few lines of `Bun.sql`.
 *
 * Better Auth's own tables are NOT managed here. They belong to
 * `bunx auth migrate`. Keep the two paths separate.
 *
 * Usage:
 *   bun run db:migrate
 *   bun run db:migrate --dry-run
 */

import { sql, type SQL } from "bun";
import { MigrationError } from "@/lib/errors";
import { log } from "@/lib/logger";

/**
 * Fixed key for `pg_advisory_lock`. Two instances rolling-deploying at once would
 * otherwise both try to apply the same migration.
 */
const ADVISORY_LOCK_KEY = 4_827_301_556;

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url).pathname;

export type Migration = {
  version: string;
  name: string;
  path: string;
  sqlText: string;
  checksum: string;
};

export type MigrateResult = {
  applied: string[];
  skipped: string[];
  pending: string[];
};

// ── discovery ─────────────────────────────────────────────────────────────────

function checksum(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** Read and sort every `NNNN_*.sql`. Rejects duplicate version prefixes. */
export async function discoverMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const glob = new Bun.Glob("[0-9][0-9][0-9][0-9]_*.sql");
  const files = (await Array.fromAsync(glob.scan({ cwd: dir }))).sort();

  const migrations: Migration[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    const version = file.slice(0, 4);
    const existing = seen.get(version);
    if (existing !== undefined) {
      throw new MigrationError(
        `duplicate migration version ${version}: ${existing} and ${file}`,
        file,
      );
    }
    seen.set(version, file);

    const path = `${dir}${file}`;
    const sqlText = await Bun.file(path).text();
    migrations.push({ version, name: file, path, sqlText, checksum: checksum(sqlText) });
  }

  return migrations;
}

// ── ledger ────────────────────────────────────────────────────────────────────

/**
 * The ledger table is itself migration 0001, so it must exist before we can read
 * applied state. Applying 0001 unconditionally is safe — it is `IF NOT EXISTS`.
 */
async function ensureLedger(db: SQL, migrations: Migration[]): Promise<void> {
  const first = migrations[0];
  if (first === undefined || first.version !== "0001") {
    throw new MigrationError("migration 0001 (schema_migration ledger) is missing");
  }
  await db.unsafe(first.sqlText);
}

async function readApplied(db: SQL): Promise<Map<string, string>> {
  const rows = (await db`SELECT version, checksum FROM schema_migration`) as {
    version: string;
    checksum: string;
  }[];
  return new Map(rows.map(r => [r.version, r.checksum]));
}

/**
 * Forward-only means an applied migration file is immutable. If one changed, the
 * database and the repository disagree about what is deployed — stop, apply
 * nothing, and name the file.
 */
function verifyChecksums(migrations: Migration[], applied: Map<string, string>): void {
  for (const migration of migrations) {
    const recorded = applied.get(migration.version);
    if (recorded !== undefined && recorded !== migration.checksum) {
      throw new MigrationError(
        `migration ${migration.name} was modified after it was applied. ` +
          `Forward-only: fix it with a new migration instead of editing this one.`,
        migration.name,
      );
    }
  }
}

// ── apply ─────────────────────────────────────────────────────────────────────

/**
 * Each migration runs together with its ledger insert in ONE transaction, so a
 * failure leaves neither partial DDL nor a ledger row claiming success.
 *
 * Postgres DDL is transactional, which is what makes this work.
 */
async function applyOne(db: SQL, migration: Migration): Promise<void> {
  await db.begin(async tx => {
    await tx.unsafe(migration.sqlText);
    await tx`
      INSERT INTO schema_migration (version, name, checksum)
      VALUES (${migration.version}, ${migration.name}, ${migration.checksum})
      ON CONFLICT (version) DO NOTHING
    `;
  });
}

/**
 * Options exist so tests can run the REAL runner against a disposable schema.
 * Without an injectable client the tests would have to reimplement this logic,
 * and a test that reimplements the code under test proves very little.
 */
export type MigrateOptions = {
  dryRun?: boolean;
  /** Defaults to Bun's default `sql` client, which reads DATABASE_URL. */
  client?: SQL;
  /** Defaults to `src/db/migrations/`. */
  dir?: string;
};

export async function migrate(options: MigrateOptions = {}): Promise<MigrateResult> {
  const dryRun = options.dryRun ?? false;
  const db = options.client ?? sql;
  const migrations = await discoverMigrations(options.dir ?? MIGRATIONS_DIR);

  if (migrations.length === 0) {
    throw new MigrationError("no migrations found — expected src/db/migrations/NNNN_*.sql");
  }

  // Serialise concurrent runners. Released in the finally below.
  await db`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;

  try {
    await ensureLedger(db, migrations);

    const applied = await readApplied(db);
    verifyChecksums(migrations, applied);

    const pending = migrations.filter(m => !applied.has(m.version));

    if (dryRun) {
      return {
        applied: [],
        skipped: migrations.filter(m => applied.has(m.version)).map(m => m.name),
        pending: pending.map(m => m.name),
      };
    }

    const appliedNow: string[] = [];
    for (const migration of pending) {
      await applyOne(db, migration);
      appliedNow.push(migration.name);
      // Filename only — never the connection target.
      log.info("migration_applied", { migration: migration.name });
    }

    return {
      applied: appliedNow,
      skipped: migrations.filter(m => applied.has(m.version)).map(m => m.name),
      pending: [],
    };
  } finally {
    await db`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  }
}

// ── entry point ───────────────────────────────────────────────────────────────

if (import.meta.main) {
  const dryRun = Bun.argv.includes("--dry-run");

  try {
    const result = await migrate({ dryRun });

    if (dryRun) {
      log.info("migration_dry_run", { pending: result.pending.length, alreadyApplied: result.skipped.length });
      for (const name of result.pending) console.log(`  pending: ${name}`);
    } else {
      log.info("migration_complete", { applied: result.applied.length, skipped: result.skipped.length });
    }

    process.exit(0);
  } catch (error) {
    // Message and migration name only. A driver error can embed the connection
    // target, so it is logged as a cause server-side and never printed raw.
    if (error instanceof MigrationError) {
      log.error("migration_failed", error, { migration: error.migration ?? null });
    } else {
      log.error("migration_failed", error);
    }
    process.exit(1);
  }
}
