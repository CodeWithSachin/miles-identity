/**
 * The reversible merge procedure — `.agents/skills/alias-identity.md`:
 *
 *   1. Pick survivor: oldest verified account, or the Salesforce-linked one
 *   2. Move all identities to survivor; first verified per type becomes is_primary
 *   3. Union product access — widest role wins, log the widening
 *   4. INSERT identity_merge_log { survivor, merged, tier, evidence, actor }
 *   5. Loser: status='merged', merged_into_user_id=survivor   ← NEVER DELETE
 *   6. Update each product DB identity_user_id → survivor
 *   7. Revoke BOTH users' sessions and refresh tokens
 *
 * Steps 2–5 run in one `Bun.sql` transaction (this repo's tables only). Step 7
 * runs immediately after that transaction commits, via injected calls into
 * Better Auth's own adapter (a separate `pg` pool — it cannot share the
 * `Bun.sql` transaction; see prompts/010, "What it read"). Step 6 (each
 * product's own `identity_user_id` column) is out of scope for this repository
 * entirely — docs/architecture-plan.md §6, not Miles Identity's job.
 *
 * `mergeUsers` receives the survivor/loser decision already made — it does not
 * re-derive it (prompts/010 Assumption 11). `pickSurvivor` implements step 1 as
 * a separate, pure function so a caller (the dedup auto-merge pass, or a future
 * human-approval action) can use it without being forced through this file's
 * transaction.
 */

import { sql, type SQL } from "bun";
import { newId } from "@/db/types";
import type { MergeTier } from "@/db/types";
import { DatabaseError } from "@/lib/errors";
import { log } from "@/lib/logger";

export type MergeCandidateUser = {
  id: string;
  createdAt: Date;
  salesforceContactId: string | null;
};

/**
 * Step 1. The Salesforce-linked user wins outright, regardless of age — a
 * Salesforce-provisioned identity is the canonical record for that person. If
 * neither or both are Salesforce-linked, the older (earlier `createdAt`)
 * account survives.
 */
export function pickSurvivor(a: MergeCandidateUser, b: MergeCandidateUser): { survivorId: string; loserId: string } {
  const aLinked = a.salesforceContactId !== null;
  const bLinked = b.salesforceContactId !== null;

  if (aLinked !== bLinked) {
    return aLinked ? { survivorId: a.id, loserId: b.id } : { survivorId: b.id, loserId: a.id };
  }

  const survivor = a.createdAt <= b.createdAt ? a : b;
  const loser = survivor === a ? b : a;
  return { survivorId: survivor.id, loserId: loser.id };
}

export type MergeInput = {
  survivorId: string;
  loserId: string;
  tier: MergeTier;
  evidence: Record<string, unknown>;
  actor: string;
};

/**
 * Step 7's collaborators. Both live in Better Auth's `pg` pool, reached
 * through `auth.$context` by the caller (`src/services/dedup.ts`'s CLI
 * entrypoint) — this module stays free of any `@/auth` import, matching
 * `identity/`'s role as core domain logic, not wiring.
 */
export type MergeDeps = {
  deleteUserSessions: (userId: string) => Promise<void>;
  revokeOAuthTokensForUser: (userId: string) => Promise<void>;
};

export type MergeResult = { merged: boolean };

/**
 * Idempotent: a loser already `status='merged'` is a no-op, not an error —
 * re-running the dedup pass or retrying after a step-7 failure must not write
 * a second `identity_merge_log` row or re-run the identity/access moves.
 */
export async function mergeUsers(input: MergeInput, deps: MergeDeps, client: SQL = sql): Promise<MergeResult> {
  if (input.survivorId === input.loserId) {
    throw new Error("mergeUsers: survivorId and loserId must be distinct");
  }

  const existing = (await client`
    SELECT status FROM "user" WHERE id = ${input.loserId}
  `) as { status: string }[];
  if (existing[0]?.status === "merged") {
    return { merged: false };
  }

  try {
    await client.begin(async (tx) => {
      // Step 2a: clear the loser's own primary flags first, so moving its rows
      // in step 2b can never collide with uq_primary_per_type on the survivor.
      await tx`UPDATE user_identity SET is_primary = false WHERE user_id = ${input.loserId}`;

      // Step 2b: move every identity to the survivor.
      await tx`UPDATE user_identity SET user_id = ${input.survivorId} WHERE user_id = ${input.loserId}`;

      // Step 2c: for each handle type, if the survivor has no primary yet (it
      // may already have one — that one is left alone), promote its earliest
      // verified identity of that type.
      for (const type of ["email", "phone"] as const) {
        await tx`
          UPDATE user_identity SET is_primary = true
          WHERE id = (
            SELECT id FROM user_identity
            WHERE user_id = ${input.survivorId} AND type = ${type} AND is_verified = true
            ORDER BY verified_at ASC, created_at ASC
            LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM user_identity
            WHERE user_id = ${input.survivorId} AND type = ${type} AND is_primary = true
          )
        `;
      }

      // Step 3: union active product access. A NOT EXISTS guard means this
      // never hits uq_access_user_product_role — any (product, role) the
      // survivor already holds (active or revoked) is left on the loser's
      // now-inert row rather than attempted twice.
      await tx`
        UPDATE user_product_access AS loser_row
        SET user_id = ${input.survivorId}
        WHERE loser_row.user_id = ${input.loserId}
          AND loser_row.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM user_product_access existing
            WHERE existing.user_id = ${input.survivorId}
              AND existing.product_id = loser_row.product_id
              AND existing.role = loser_row.role
          )
      `;

      // Step 4: append-only audit row (trigger-enforced, migration 0005).
      await tx`
        INSERT INTO identity_merge_log (id, survivor_user_id, merged_user_id, tier, evidence, actor)
        VALUES (${newId("merge")}, ${input.survivorId}, ${input.loserId}, ${input.tier}, ${JSON.stringify(input.evidence)}, ${input.actor})
      `;

      // Step 5: never delete — a stale reference must resolve to the survivor,
      // not 404.
      await tx`
        UPDATE "user" SET status = 'merged', merged_into_user_id = ${input.survivorId} WHERE id = ${input.loserId}
      `;
    });
  } catch (error) {
    throw new DatabaseError("merge_users", { cause: error });
  }

  // Step 7: outside the Bun.sql transaction above — Better Auth's session and
  // oauthAccessToken tables live behind a separate `pg` pool that cannot share
  // it. Revoke BOTH sides: the survivor's own token claims may now be stale
  // the instant access was unioned (.agents/skills/security.md).
  await deps.deleteUserSessions(input.survivorId);
  await deps.deleteUserSessions(input.loserId);
  await deps.revokeOAuthTokensForUser(input.survivorId);
  await deps.revokeOAuthTokensForUser(input.loserId);

  log.info("identity_merge", { survivorId: input.survivorId, loserId: input.loserId, tier: input.tier });

  return { merged: true };
}
