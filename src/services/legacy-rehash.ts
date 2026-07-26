/**
 * Rehash-on-login for step 9's Masterclass legacy import: the first successful
 * sign-in against an imported Django PBKDF2 hash upgrades it to argon2id and
 * clears `importedHashAlgo`, so the account is unaffected by
 * `DJANGO_LEGACY_PASSWORD_LOGIN_ENABLED` from that point on
 * (docs/architecture-plan.md:482, prompts/009).
 *
 * Business logic only (AGENTS.md: services/ = logic, no Request/Response). The
 * caller (src/auth.ts's `hooks.after`) already guarantees this only runs after
 * a REAL verified sign-in success — this function does not re-verify the
 * password, it only decides whether to rehash it.
 *
 * Collaborators are injected (same reasoning as src/services/otp-signin.ts and
 * src/services/access.ts) so the decision logic — "is this account still on an
 * imported hash?" — is unit-testable without a live Better Auth adapter.
 */

export type LegacyUser = { id: string; importedHashAlgo?: string | null };
export type LegacyAccount = { id: string; providerId: string };

export type RehashDeps = {
  findUserByEmail: (email: string) => Promise<{ user: LegacyUser; accounts: LegacyAccount[] } | null>;
  updateAccount: (accountId: string, data: { password: string }) => Promise<unknown>;
  updateUser: (userId: string, data: { importedHashAlgo: null }) => Promise<unknown>;
  hashPassword: (password: string) => Promise<string>;
};

/**
 * No-op for any account that was never imported (`importedHashAlgo` unset) or
 * that has no `credential` provider account. Returns whether a rehash happened,
 * for testability.
 */
export async function rehashLegacyPasswordOnSignIn(
  email: string,
  password: string,
  deps: RehashDeps,
): Promise<boolean> {
  const found = await deps.findUserByEmail(email);
  if (!found || !found.user.importedHashAlgo) return false;

  const credentialAccount = found.accounts.find((a) => a.providerId === "credential");
  if (!credentialAccount) return false;

  await deps.updateAccount(credentialAccount.id, { password: await deps.hashPassword(password) });
  await deps.updateUser(found.user.id, { importedHashAlgo: null });
  return true;
}
