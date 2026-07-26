/**
 * Read-only access to LMS's legacy Node database (AGENTS.md: integrations/ =
 * external systems). Used exactly once, by the offline import job
 * (`src/services/legacy-import.ts`) — never from a request handler. Same
 * reasoning as `legacy-masterclass-db.ts`: Miles Identity imports the legacy
 * password hash, it never proxies a credential check to this database at
 * login time (docs/architecture-plan.md:463).
 *
 * A second, explicit `Bun.SQL` client, per .agents/skills/bun-native.md ("the
 * legacy source DB") — distinct from the default `sql` client (our own
 * database) and from Better Auth's `pg` Pool.
 *
 * Assumes a `users` table shaped like Masterclass/Miles One's `auth_user`
 * (prompts/010 assumption 1) — LMS is Node, "almost certainly bcrypt" per
 * docs/architecture-plan.md:465, but its exact schema is unconfirmed. Confirm
 * against a real LMS staging copy before running anywhere else. If wrong, this
 * file is the only one that changes.
 */

import { SQL } from "bun";
import { requireLater } from "@/lib/config";

export type LegacyLmsAccount = {
  email: string;
  /** The raw bcrypt `$2[aby]$...` hash string, untouched. */
  password: string;
  isActive: boolean;
  firstName: string;
  lastName: string;
};

let client: SQL | undefined;

/** Lazy for the same reason `getRedis`/`legacyDb` are lazy in src/auth.ts: keeps
 * this module importable under the Better Auth CLI's jiti/Node loader. */
function getLegacyDb(): SQL {
  client ??= new SQL(requireLater("LEGACY_LMS_DATABASE_URL"));
  return client;
}

export async function fetchLegacyLmsAccounts(): Promise<LegacyLmsAccount[]> {
  const db = getLegacyDb();
  const rows = (await db`
    SELECT email, password, is_active, first_name, last_name FROM users
  `) as { email: string; password: string; is_active: boolean; first_name: string; last_name: string }[];
  return rows.map(row => ({
    email: row.email,
    password: row.password,
    isActive: row.is_active,
    firstName: row.first_name,
    lastName: row.last_name,
  }));
}
