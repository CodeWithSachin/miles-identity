/**
 * One-off import of Masterclass's legacy (Django) password accounts into Better
 * Auth's own `user`/`account` tables plus a verified `user_identity` row
 * (prompts/009 — pulled forward from roadmap step 10, scoped to Masterclass
 * only). The hash string is imported and dispatched on format locally
 * (src/auth.ts's `passwordHasher.verify`) — this job never checks a password
 * against the legacy database at request time (docs/architecture-plan.md:463
 * explicitly rejects that approach).
 *
 * Business logic only (AGENTS.md: services/ = logic, no Request/Response).
 * Collaborators are injected, same reasoning as `src/services/access.ts` and
 * `src/db/seed-oauth-clients.ts`: the real Better-Auth-adapter and real-Postgres
 * behaviour is exercised via the CLI entrypoint below; here it is a seam so the
 * per-row decision logic (skip inactive, skip already-claimed, import) is
 * testable without a live database.
 *
 * Never logs an email, password, or hash (security.md) — only counts.
 */

import { normaliseHandle } from "@/identity/normalise";
import { identityValueExists, createVerifiedIdentity } from "@/db/identity";
import { fetchLegacyMasterclassAccounts, type LegacyMasterclassAccount } from "@/integrations/legacy-masterclass-db";
import { log } from "@/lib/logger";

export type ImportSummary = {
  imported: number;
  skippedExisting: number;
  skippedInactive: number;
  skippedInvalid: number;
};

export type ImportDeps = {
  fetchAccounts: () => Promise<LegacyMasterclassAccount[]>;
  identityValueExists: (type: "email", value: string) => Promise<boolean>;
  createVerifiedIdentity: (input: {
    userId: string;
    type: "email";
    value: string;
    source: "masterclass";
  }) => Promise<unknown>;
  createUser: (input: {
    email: string;
    name: string;
    importedHashAlgo: string;
  }) => Promise<{ id: string }>;
  createAccount: (input: { userId: string; accountId: string; providerId: string; password: string }) => Promise<unknown>;
};

const defaultDeps: ImportDeps = {
  fetchAccounts: fetchLegacyMasterclassAccounts,
  identityValueExists: (type, value) => identityValueExists(type, value),
  createVerifiedIdentity: input => createVerifiedIdentity(input),
  createUser: async () => {
    throw new Error("createUser must be supplied by the CLI entrypoint (needs the live auth.$context adapter)");
  },
  createAccount: async () => {
    throw new Error("createAccount must be supplied by the CLI entrypoint (needs the live auth.$context adapter)");
  },
};

function displayName(account: LegacyMasterclassAccount, email: string): string {
  const joined = `${account.firstName} ${account.lastName}`.trim();
  return joined.length > 0 ? joined : email;
}

/**
 * Imports every active legacy account whose email is not already claimed by
 * ANY existing identity (verified or not) — dedup/merge across systems is step
 * 10's job, not this one. Idempotent: re-running skips everything already
 * imported.
 */
export async function importLegacyMasterclassUsers(deps: ImportDeps = defaultDeps): Promise<ImportSummary> {
  const summary: ImportSummary = { imported: 0, skippedExisting: 0, skippedInactive: 0, skippedInvalid: 0 };

  for (const account of await deps.fetchAccounts()) {
    if (!account.isActive) {
      summary.skippedInactive += 1;
      continue;
    }

    const parsed = normaliseHandle(account.email);
    if (!parsed || parsed.type !== "email") {
      summary.skippedInvalid += 1;
      continue;
    }

    if (await deps.identityValueExists("email", parsed.value)) {
      summary.skippedExisting += 1;
      continue;
    }

    const user = await deps.createUser({
      email: parsed.value,
      name: displayName(account, parsed.value),
      importedHashAlgo: "django_pbkdf2",
    });
    await deps.createAccount({
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: account.password,
    });
    await deps.createVerifiedIdentity({ userId: user.id, type: "email", value: parsed.value, source: "masterclass" });

    summary.imported += 1;
  }

  log.info("legacy_masterclass_import", { ...summary });
  return summary;
}

if (import.meta.main) {
  const { auth } = await import("@/auth");
  const ctx = await auth.$context;
  const result = await importLegacyMasterclassUsers({
    ...defaultDeps,
    createUser: input => ctx.internalAdapter.createUser(input),
    createAccount: input => ctx.internalAdapter.createAccount(input),
  });
  console.log(
    `[legacy-import] imported ${result.imported}, skipped ${result.skippedExisting} existing, ` +
      `${result.skippedInactive} inactive, ${result.skippedInvalid} invalid`,
  );
}
