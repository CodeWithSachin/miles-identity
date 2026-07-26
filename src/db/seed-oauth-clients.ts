/**
 * Registers the four trusted first-party OAuth clients as rows in Better Auth's
 * own `oauthClient` table. There is no static `trustedClients` option on the
 * installed `@better-auth/oauth-provider` — clients are just DB rows, normally
 * created through a session-gated `/oauth2/create-client` endpoint meant for
 * end-user/dynamic registration. This script writes them directly via the same
 * adapter Better Auth's own endpoint uses (`ctx.adapter.create`), reached through
 * the same `auth.$context` accessor already relied on by `auth-schema.ts`.
 *
 * Idempotent and safe to re-run: existing clients get their redirect URIs and
 * skipConsent refreshed, but an already-stored `clientSecret` is never touched —
 * secret rotation is a separate, deliberate action, not a side effect of sync.
 *
 * Usage: bun run oauth:clients:sync
 */

import type { TrustedClientDefinition } from "@/auth/oauth-clients";

type OAuthAdapter = {
  findOne<T>(data: { model: string; where: { field: string; value: unknown }[] }): Promise<T | null>;
  create(data: { model: string; data: Record<string, unknown> }): Promise<unknown>;
  update(data: {
    model: string;
    where: { field: string; value: unknown }[];
    update: Record<string, unknown>;
  }): Promise<unknown>;
};

type SecretHasher = { hash: (value: string) => Promise<string> };

/**
 * Core sync logic, parameterised on the adapter/hasher/client list so it can run
 * against either the real `@/auth` singleton (CLI entrypoint below) or a disposable
 * test schema (tests/db/seed-oauth-clients.test.ts) — never a second live instance
 * mounted as a request handler, just the DB write path under test.
 */
export async function syncOAuthClients(
  adapter: OAuthAdapter,
  hasher: SecretHasher,
  clients: TrustedClientDefinition[],
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (const client of clients) {
    const existing = await adapter.findOne<{ clientId: string }>({
      model: "oauthClient",
      where: [{ field: "clientId", value: client.clientId }],
    });

    if (existing === null) {
      await adapter.create({
        model: "oauthClient",
        data: {
          clientId: client.clientId,
          clientSecret: client.clientSecret ? await hasher.hash(client.clientSecret) : undefined,
          redirectUris: client.redirectUris,
          type: client.type,
          public: client.type === "native",
          skipConsent: true,
          requirePKCE: true,
          disabled: false,
        },
      });
      created += 1;
      continue;
    }

    // Never touch clientSecret here — rotation is a separate, explicit action.
    await adapter.update({
      model: "oauthClient",
      where: [{ field: "clientId", value: client.clientId }],
      update: {
        redirectUris: client.redirectUris,
        skipConsent: true,
        disabled: false,
      },
    });
    updated += 1;
  }

  return { created, updated };
}

if (import.meta.main) {
  const { auth, oauthClientSecretHasher } = await import("@/auth");
  const { trustedClients } = await import("@/auth/oauth-clients");
  const ctx = await auth.$context;
  const result = await syncOAuthClients(ctx.adapter, oauthClientSecretHasher, trustedClients());
  console.log(`[oauth-clients] created ${result.created}, updated ${result.updated}`);
}
