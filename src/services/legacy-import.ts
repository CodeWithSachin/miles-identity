/**
 * One-off import of legacy password accounts into Better Auth's own
 * `user`/`account` tables plus a verified `user_identity` row. Started
 * Masterclass-only (prompts/009, Django/PBKDF2), generalised here (prompts/010)
 * to LMS (Node/bcrypt) and Miles One (Django/PBKDF2) — same per-row logic for
 * all three, parameterised on `LegacySource`. The hash string is imported and
 * dispatched on format locally (src/auth.ts's `passwordHasher.verify`) — this
 * job never checks a password against a legacy database at request time
 * (docs/architecture-plan.md:463 explicitly rejects that approach).
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
import { fetchLegacyLmsAccounts, type LegacyLmsAccount } from "@/integrations/legacy-lms-db";
import { fetchLegacyMilesOneAccounts, type LegacyMilesOneAccount } from "@/integrations/legacy-miles-one-db";
import { log } from "@/lib/logger";

export const LEGACY_SOURCES = ["lms", "miles_one", "masterclass"] as const;
export type LegacySource = (typeof LEGACY_SOURCES)[number];

/** The shape every legacy fetcher returns — Masterclass's, LMS's and Miles One's
 * account types are structurally identical, so one import loop serves all three. */
export type LegacyAccount = LegacyMasterclassAccount | LegacyLmsAccount | LegacyMilesOneAccount;

export type ImportSummary = {
  imported: number;
  skippedExisting: number;
  skippedInactive: number;
  skippedInvalid: number;
};

export type ImportDeps = {
  fetchAccounts: () => Promise<LegacyAccount[]>;
  identityValueExists: (type: "email", value: string) => Promise<boolean>;
  createVerifiedIdentity: (input: {
    userId: string;
    type: "email";
    value: string;
    source: LegacySource;
  }) => Promise<unknown>;
  createUser: (input: {
    email: string;
    name: string;
    importedHashAlgo: string;
  }) => Promise<{ id: string }>;
  createAccount: (input: { userId: string; accountId: string; providerId: string; password: string }) => Promise<unknown>;
};

/** The one fact that varies by source beyond the fetcher: which hash family the
 * imported password is in — read by `src/auth.ts`'s `passwordHasher.verify` to
 * pick the right verification branch. Bcrypt (LMS) needs no gate flag there;
 * PBKDF2 (Miles One, Masterclass — both Django) shares one gate
 * (`DJANGO_LEGACY_PASSWORD_LOGIN_ENABLED`, prompts/010 Assumption 3). */
const IMPORTED_HASH_ALGO: Record<LegacySource, string> = {
  lms: "node_bcrypt",
  miles_one: "django_pbkdf2",
  masterclass: "django_pbkdf2",
};

const FETCHERS: Record<LegacySource, () => Promise<LegacyAccount[]>> = {
  lms: fetchLegacyLmsAccounts,
  miles_one: fetchLegacyMilesOneAccounts,
  masterclass: fetchLegacyMasterclassAccounts,
};

function defaultDeps(source: LegacySource): ImportDeps {
  return {
    fetchAccounts: FETCHERS[source],
    identityValueExists: (type, value) => identityValueExists(type, value),
    createVerifiedIdentity: input => createVerifiedIdentity(input),
    createUser: async () => {
      throw new Error("createUser must be supplied by the CLI entrypoint (needs the live auth.$context adapter)");
    },
    createAccount: async () => {
      throw new Error("createAccount must be supplied by the CLI entrypoint (needs the live auth.$context adapter)");
    },
  };
}

function displayName(account: LegacyAccount, email: string): string {
  const joined = `${account.firstName} ${account.lastName}`.trim();
  return joined.length > 0 ? joined : email;
}

/**
 * Imports every active legacy account whose email is not already claimed by
 * ANY existing identity (verified or not) — dedup/merge of a person who used a
 * *different* handle in another product is `src/services/dedup.ts`'s job, not
 * this one. Idempotent: re-running skips everything already imported.
 */
export async function importLegacyUsers(source: LegacySource, deps: ImportDeps): Promise<ImportSummary> {
  const summary: ImportSummary = { imported: 0, skippedExisting: 0, skippedInactive: 0, skippedInvalid: 0 };
  const importedHashAlgo = IMPORTED_HASH_ALGO[source];

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
      importedHashAlgo,
    });
    await deps.createAccount({
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: account.password,
    });
    await deps.createVerifiedIdentity({ userId: user.id, type: "email", value: parsed.value, source });

    summary.imported += 1;
  }

  log.info("legacy_import", { source, ...summary });
  return summary;
}

function parseSourceArg(argv: string[]): LegacySource {
  const arg = argv.find(a => a.startsWith("--source="));
  const value = arg?.slice("--source=".length);
  if (!value || !(LEGACY_SOURCES as readonly string[]).includes(value)) {
    throw new Error(`--source=<${LEGACY_SOURCES.join("|")}> is required`);
  }
  return value as LegacySource;
}

if (import.meta.main) {
  const source = parseSourceArg(Bun.argv);
  const { auth } = await import("@/auth");
  const ctx = await auth.$context;
  const result = await importLegacyUsers(source, {
    ...defaultDeps(source),
    createUser: input => ctx.internalAdapter.createUser(input),
    createAccount: input => ctx.internalAdapter.createAccount(input),
  });
  console.log(
    `[legacy-import:${source}] imported ${result.imported}, skipped ${result.skippedExisting} existing, ` +
      `${result.skippedInactive} inactive, ${result.skippedInvalid} invalid`,
  );
}
