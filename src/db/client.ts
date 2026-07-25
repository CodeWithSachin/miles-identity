/**
 * Postgres via `Bun.sql`. All of OUR queries go through this.
 *
 * Better Auth uses a separate `pg` Pool (Kysely requirement) — that arrives in
 * step 3. Two clients, one database, by design. See skills/better-auth.md.
 *
 * Step 1 scope: connectivity only. No schema, no domain queries. Step 2 owns those.
 */

import { sql } from "bun";
import type { TransactionSQL } from "bun";
import { log } from "@/lib/logger";
import { DatabaseError } from "@/lib/errors";

export { sql };

const DEFAULT_TIMEOUT_MS = 2000;

/** The transaction handle Bun hands to a `sql.begin` callback. */
export type Transaction = TransactionSQL;

/**
 * Run a function inside a transaction, mapping any failure to `DatabaseError`
 * with the driver error preserved as `cause`.
 *
 * IMPORTANT: use the `tx` argument for every statement inside the callback. Using
 * the outer `sql` runs that statement *outside* the transaction — silently, with
 * no error — which is how a merge half-commits or an outbox row goes missing.
 *
 *   await transaction(async tx => {
 *     await tx`INSERT INTO ...`;          // correct
 *     await sql`INSERT INTO ...`;         // WRONG: not in the transaction
 *   });
 */
export async function transaction<T>(operation: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  try {
    return (await sql.begin(fn as never)) as T;
  } catch (error) {
    throw new DatabaseError(operation, { cause: error });
  }
}

/**
 * `SELECT 1` with a timeout. Never throws — a readiness probe must not become
 * a source of unhandled rejections.
 *
 * Returns a boolean only. The failure reason is logged server-side and is
 * deliberately not returned, so it cannot reach an unauthenticated `/ready` body.
 */
export async function pingPostgres(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`postgres ping exceeded ${timeoutMs}ms`)), timeoutMs);
    });

    await Promise.race([sql`SELECT 1`, timeout]);
    return true;
  } catch (error) {
    // Server-side only. Bun.sql errors can embed the connection target, so this
    // must never be returned to a caller.
    log.warn("postgres_ping_failed", { reason: error instanceof Error ? error.name : "unknown" });
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
