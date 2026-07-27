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

/**
 * Create an UNVERIFIED identity (prompts/013: Salesforce provisioning on Lead
 * conversion). AGENTS.md security rule 11 / alias-identity.md: "Lead conversion
 * is not identity verification" — this handle cannot authenticate or receive a
 * sign-in OTP until it is separately verified.
 *
 * `ON CONFLICT ... DO NOTHING`, same reasoning as `createVerifiedIdentity`: a
 * conflict means the handle already belongs to someone, and a repeated
 * provisioning callout for the same contact must not duplicate or error.
 */
export async function createUnverifiedIdentity(
  input: { userId: string; type: IdentityType; value: string; source: IdentitySource },
  client: SQL = sql,
): Promise<UserIdentityRow | null> {
  const rows = (await client`
    INSERT INTO user_identity (id, user_id, type, value, is_primary, is_verified, source, verified_at)
    VALUES (${newId("identity")}, ${input.userId}, ${input.type}, ${input.value}, false, false, ${input.source}, NULL)
    ON CONFLICT (type, value) DO NOTHING
    RETURNING *
  `) as UserIdentityRow[];
  return rows[0] ?? null;
}

/**
 * Resolve a handle to its owning user REGARDLESS of verification state.
 *
 * **Never call this on a login or OTP-sending path** — only
 * `findUserIdByVerifiedHandle` may decide who can authenticate (alias-identity.md
 * rule 1). This exists solely for Salesforce provisioning-time resolution
 * (prompts/013): attaching a `salesforce_contact_id` and coarse `NORMAL` product
 * access to whichever existing identity already owns a handle does not
 * authenticate anyone, so it is safe to resolve an unverified match too.
 */
export async function findUserIdByAnyHandle(
  type: IdentityType,
  value: string,
  client: SQL = sql,
): Promise<string | null> {
  const rows = (await client`
    SELECT user_id FROM user_identity
    WHERE type = ${type} AND value = ${value}
    LIMIT 1
  `) as { user_id: string }[];
  return rows[0]?.user_id ?? null;
}

/** A Salesforce Contact id (`003…`) → the user it provisioned, if any (prompts/013 idempotency key). */
export async function findUserIdBySalesforceContactId(
  contactId: string,
  client: SQL = sql,
): Promise<string | null> {
  const rows = (await client`
    SELECT id FROM "user" WHERE salesforce_contact_id = ${contactId} LIMIT 1
  `) as { id: string }[];
  return rows[0]?.id ?? null;
}

/**
 * Attach a Salesforce Contact id to a user that does not already have one.
 * Guarded by `salesforce_contact_id IS NULL` in the `WHERE` clause so this can
 * never silently overwrite an existing, different link — returns `false` when
 * no row was updated, which the caller must then check: already linked to
 * THIS same contact id is a harmless idempotent replay, linked to a DIFFERENT
 * one is a real conflict (prompts/013, Assumption 2).
 */
export async function linkSalesforceContactId(
  userId: string,
  contactId: string,
  client: SQL = sql,
): Promise<boolean> {
  const rows = (await client`
    UPDATE "user" SET salesforce_contact_id = ${contactId}
    WHERE id = ${userId} AND salesforce_contact_id IS NULL
    RETURNING id
  `) as { id: string }[];
  return rows.length > 0;
}

/**
 * Records that a `usr_` id has been (or already was) linked to a Salesforce
 * Contact, driving the back-reference PATCH (prompts/013, Assumption 4) —
 * written in the SAME transaction as the identity/access writes it accompanies
 * (AGENTS.md: a domain write and its outbox row commit together, or neither does).
 */
export async function insertSalesforceContactLinkOutboxRow(
  input: { contactId: string; userId: string },
  client: SQL = sql,
): Promise<void> {
  await client`
    INSERT INTO outbox (aggregate, event_type, payload)
    VALUES ('salesforce_contact_link', 'link', ${{ contactId: input.contactId, userId: input.userId }})
  `;
}
