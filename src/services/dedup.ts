/**
 * The dedup batch job — passes 1–2 (extract/normalise already happened at
 * import time; find + persist tiered candidates) and pass 3 for the
 * deterministic tiers (auto-merge A/B/C immediately; leave D/E for the manual
 * review queue). See `.agents/skills/alias-identity.md` and
 * `docs/architecture-plan.md` §8. Run once, pre-launch
 * ("run this before any SSO goes live") — a one-off CLI script, not a
 * `Bun.cron` schedule, matching `legacy-import.ts`'s precedent (prompts/010
 * Assumption 9).
 *
 * Business logic only (AGENTS.md: services/ = logic, no Request/Response).
 * Collaborators are injected so the auto-merge/leave-pending decision is
 * testable without a live database or a live Better Auth adapter.
 *
 * Never logs a name, email or phone (security.md) — only ids, tiers and counts.
 */

import { pickSurvivor, type MergeCandidateUser, type MergeInput, type MergeResult } from "@/identity/merge";
import type { DedupCandidate } from "@/db/dedup";
import type { DedupCandidateRow, MergeTier } from "@/db/types";
import { log } from "@/lib/logger";

/** Tiers confident enough to merge the instant they're found — never D or E,
 * which always land in the manual review queue (the whole point of tiering). */
const AUTO_MERGE_TIERS: readonly MergeTier[] = ["A", "B", "C"];

function isAutoMergeTier(tier: MergeTier): boolean {
  return (AUTO_MERGE_TIERS as readonly string[]).includes(tier);
}

export type DedupSummary = {
  foundByTier: Record<MergeTier, number>;
  autoMerged: number;
  pending: number;
};

export type DedupDeps = {
  findCandidates: () => Promise<DedupCandidate[]>;
  insertCandidate: (candidate: DedupCandidate) => Promise<DedupCandidateRow | null>;
  markDecided: (id: string, status: "merged", actor: string) => Promise<void>;
  fetchUserForMerge: (userId: string) => Promise<MergeCandidateUser>;
  mergeUsers: (input: MergeInput) => Promise<MergeResult>;
  actor: string;
};

function emptyTierCounts(): Record<MergeTier, number> {
  return { A: 0, B: 0, C: 0, D: 0, E: 0 };
}

/**
 * Runs every wired tier's finder, persists each result (idempotent —
 * `insertCandidate` returns `null` for a pair already queued or decided by an
 * earlier run), then immediately merges any A/B/C match. D and E candidates
 * are left `status='pending'` — this function never calls `mergeUsers` for
 * them, by construction (`isAutoMergeTier`), not merely by convention.
 */
export async function runDedup(deps: DedupDeps): Promise<DedupSummary> {
  const foundByTier = emptyTierCounts();
  let autoMerged = 0;
  let pending = 0;

  for (const candidate of await deps.findCandidates()) {
    foundByTier[candidate.tier] += 1;

    const row = await deps.insertCandidate(candidate);
    if (row === null) continue; // already queued or decided — idempotent re-run

    if (!isAutoMergeTier(candidate.tier)) {
      pending += 1;
      continue;
    }

    const [userA, userB] = await Promise.all([
      deps.fetchUserForMerge(candidate.userIdA),
      deps.fetchUserForMerge(candidate.userIdB),
    ]);
    const { survivorId, loserId } = pickSurvivor(userA, userB);

    await deps.mergeUsers({ survivorId, loserId, tier: candidate.tier, evidence: candidate.evidence, actor: deps.actor });
    await deps.markDecided(row.id, "merged", deps.actor);
    autoMerged += 1;
  }

  log.info("dedup_run", { foundByTier, autoMerged, pending });
  return { foundByTier, autoMerged, pending };
}

if (import.meta.main) {
  const { auth } = await import("@/auth");
  const { mergeUsers } = await import("@/identity/merge");
  const { findDedupCandidates, insertDedupCandidate, markDedupCandidateDecided, fetchMergeCandidateUser } = await import(
    "@/db/dedup"
  );

  const ctx = await auth.$context;
  const ACTOR = "dedup-job";

  const summary = await runDedup({
    findCandidates: findDedupCandidates,
    insertCandidate: insertDedupCandidate,
    markDecided: markDedupCandidateDecided,
    fetchUserForMerge: async userId => {
      const user = await fetchMergeCandidateUser(userId);
      if (!user) throw new Error(`dedup candidate references unknown user`);
      return user;
    },
    mergeUsers: input =>
      mergeUsers(input, {
        deleteUserSessions: userId => ctx.internalAdapter.deleteUserSessions(userId),
        revokeOAuthTokensForUser: userId =>
          ctx.adapter.deleteMany({ model: "oauthAccessToken", where: [{ field: "userId", value: userId }] }).then(() => undefined),
      }),
    actor: ACTOR,
  });

  console.log(
    `[dedup] found ${JSON.stringify(summary.foundByTier)}, auto-merged ${summary.autoMerged}, ` +
      `${summary.pending} pending review`,
  );
}
