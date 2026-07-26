/**
 * Alias-resolution queries. All identity SQL lives here (AGENTS.md: only db/
 * writes SQL). `Bun.sql`, parameterised — never interpolate an identifier.
 */

import { sql, type SQL } from "bun";
import type { IdentityType, IdentitySource, UserIdentityRow } from "@/db/types";
import { newId } from "@/db/types";

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

/**
 * Whether ANY row already claims this (type, value) — verified or not. Mirrors
 * the global `uq_identity_value` constraint, used by the legacy import
 * (src/services/legacy-import.ts) to skip an email someone already owns
 * *before* creating a user for it, rather than racing the constraint.
 */
export async function identityValueExists(
  type: IdentityType,
  value: string,
  client: SQL = sql,
): Promise<boolean> {
  const rows = (await client`
    SELECT 1 FROM user_identity WHERE type = ${type} AND value = ${value} LIMIT 1
  `) as { "?column?": number }[];
  return rows.length > 0;
}

/**
 * Create an already-verified identity for a user (step 9's legacy import: the
 * handle is trusted at import time, not proven via OTP — see prompts/009).
 *
 * `ON CONFLICT ... DO NOTHING`: the global `UNIQUE (type, value)` constraint is
 * the actual enforcement point. A conflict means this handle already belongs to
 * someone (imported earlier, or via any other source) — the caller treats a
 * `null` return as "already known, skip," never as an error.
 */
export async function createVerifiedIdentity(
  input: { userId: string; type: IdentityType; value: string; source: IdentitySource },
  client: SQL = sql,
): Promise<UserIdentityRow | null> {
  const rows = (await client`
    INSERT INTO user_identity (id, user_id, type, value, is_primary, is_verified, source, verified_at)
    VALUES (${newId("identity")}, ${input.userId}, ${input.type}, ${input.value}, true, true, ${input.source}, now())
    ON CONFLICT (type, value) DO NOTHING
    RETURNING *
  `) as UserIdentityRow[];
  return rows[0] ?? null;
}
