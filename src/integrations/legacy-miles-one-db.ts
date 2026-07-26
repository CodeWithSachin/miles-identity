/**
 * Read-only access to Miles One's legacy Django database (AGENTS.md:
 * integrations/ = external systems). Used exactly once, by the offline import
 * job (`src/services/legacy-import.ts`) — never from a request handler. Same
 * reasoning as `legacy-masterclass-db.ts`: Miles Identity imports the legacy
 * password hash, it never proxies a credential check to this database at
 * login time (docs/architecture-plan.md:463).
 *
 * A second, explicit `Bun.SQL` client, per .agents/skills/bun-native.md ("the
 * legacy source DB") — distinct from the default `sql` client (our own
 * database) and from Better Auth's `pg` Pool.
 *
 * Assumes Django's default `auth_user` table (prompts/010 assumption 2, same
 * assumption prompts/009 already carries for Masterclass — both are Django per
 * docs/architecture-plan.md:15) — confirm against the real schema before
 * running anywhere but a local/staging copy. If Miles One uses a custom user
 * model (the `AUTH_USER_MODEL` migration docs/architecture-plan.md:457 calls
 * out), this file is the only one that changes.
 */

import { SQL } from "bun";
import { requireLater } from "@/lib/config";

export type LegacyMilesOneAccount = {
  email: string;
  /** The raw Django `pbkdf2_sha256$...` hash string, untouched. */
  password: string;
  isActive: boolean;
  firstName: string;
  lastName: string;
};

let client: SQL | undefined;

/** Lazy for the same reason `getRedis`/`legacyDb` are lazy in src/auth.ts: keeps
 * this module importable under the Better Auth CLI's jiti/Node loader. */
function getLegacyDb(): SQL {
  client ??= new SQL(requireLater("LEGACY_MILES_ONE_DATABASE_URL"));
  return client;
}

export async function fetchLegacyMilesOneAccounts(): Promise<LegacyMilesOneAccount[]> {
  const db = getLegacyDb();
  const rows = (await db`
    SELECT email, password, is_active, first_name, last_name FROM auth_user
  `) as { email: string; password: string; is_active: boolean; first_name: string; last_name: string }[];
  return rows.map(row => ({
    email: row.email,
    password: row.password,
    isActive: row.is_active,
    firstName: row.first_name,
    lastName: row.last_name,
  }));
}
