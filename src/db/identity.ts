/**
 * Alias-resolution queries. All identity SQL lives here (AGENTS.md: only db/
 * writes SQL). `Bun.sql`, parameterised — never interpolate an identifier.
 */

import { sql, type SQL } from "bun";
import type { IdentityType } from "@/db/types";

/**
 * The login hot path: a verified handle → its owning user. Hits the partial
 * index `ix_identity_lookup (type, value) WHERE is_verified` from migration 0002.
 *
 * The `is_verified = true` filter is a security boundary, not an optimisation:
 * only a verified identity may ever authenticate (alias-identity.md, takeover
 * path 1). An unverified alias must resolve to null.
 *
 * `client` is injectable so tests can run against a disposable schema.
 */
export async function findUserIdByVerifiedHandle(
  type: IdentityType,
  value: string,
  client: SQL = sql,
): Promise<string | null> {
  const rows = (await client`
    SELECT user_id FROM user_identity
    WHERE type = ${type} AND value = ${value} AND is_verified = true
    LIMIT 1
  `) as { user_id: string }[];
  return rows[0]?.user_id ?? null;
}
