/**
 * `vendor` table queries (roadmap step 11 — inbound vendor SSO). All of OUR SQL
 * lives here (AGENTS.md: only db/ writes SQL). `Bun.sql`, parameterised.
 *
 * One verified domain per vendor (prompts/011, Assumption 1) — `allowed_email_domains`
 * is `text[]` in the schema, but this feature always writes/reads a single entry.
 */

import { sql, type SQL } from "bun";
import { newId } from "@/db/types";
import type { VendorRow } from "@/db/types";

export async function createVendor(
  input: { name: string; domain: string },
  client: SQL = sql,
): Promise<VendorRow> {
  const rows = (await client`
    INSERT INTO vendor (id, name, allowed_email_domains, sso_provider_id, domain_verified_at, status)
    VALUES (${newId("vendor")}, ${input.name}, ${client.array([input.domain], "TEXT")}, NULL, NULL, 'pending')
    RETURNING *
  `) as VendorRow[];
  return rows[0]!;
}

export async function getVendorById(id: string, client: SQL = sql): Promise<VendorRow | null> {
  const rows = (await client`SELECT * FROM vendor WHERE id = ${id} LIMIT 1`) as VendorRow[];
  return rows[0] ?? null;
}

/** The `provisionUser` hot path: a Better Auth `ssoProvider.providerId` → its owning vendor. */
export async function getVendorBySsoProviderId(ssoProviderId: string, client: SQL = sql): Promise<VendorRow | null> {
  const rows = (await client`SELECT * FROM vendor WHERE sso_provider_id = ${ssoProviderId} LIMIT 1`) as VendorRow[];
  return rows[0] ?? null;
}

/**
 * Registers (or re-registers, e.g. after a disable) the Better Auth SSO provider
 * a vendor authenticates through. Always resets verification state — a stale
 * `domain_verified_at` from a previous, now-replaced provider must never carry
 * over to the new one (prompts/011).
 */
export async function setVendorSsoProvider(
  id: string,
  ssoProviderId: string,
  client: SQL = sql,
): Promise<VendorRow | null> {
  const rows = (await client`
    UPDATE vendor
    SET sso_provider_id = ${ssoProviderId}, domain_verified_at = NULL, status = 'pending'
    WHERE id = ${id}
    RETURNING *
  `) as VendorRow[];
  return rows[0] ?? null;
}

/**
 * Flips a vendor to active once its domain is DNS-verified. Refuses to
 * resurrect a `disabled` vendor — a stray verify call must not silently
 * re-enable one that was deliberately turned off.
 */
export async function activateVendor(id: string, client: SQL = sql): Promise<VendorRow | null> {
  const rows = (await client`
    UPDATE vendor
    SET domain_verified_at = now(), status = 'active'
    WHERE id = ${id} AND status <> 'disabled'
    RETURNING *
  `) as VendorRow[];
  return rows[0] ?? null;
}

/**
 * Disables a vendor. Clears `sso_provider_id` alongside the underlying Better
 * Auth `ssoProvider` row deletion the caller performs (src/services/vendor-sso.ts)
 * — the two must go together, or a stale id here would point at nothing.
 */
export async function disableVendorRow(id: string, client: SQL = sql): Promise<VendorRow | null> {
  const rows = (await client`
    UPDATE vendor
    SET status = 'disabled', sso_provider_id = NULL
    WHERE id = ${id}
    RETURNING *
  `) as VendorRow[];
  return rows[0] ?? null;
}
