/**
 * runDedup (src/services/dedup.ts), driven through injected fakes — same style
 * as tests/services/legacy-import.test.ts. The real tiered queries
 * (src/db/dedup.ts) and the real merge transaction are exercised elsewhere
 * (tests/identity/merge.test.ts); here only the orchestration decision matters:
 * which tiers auto-merge, which stay pending, and that it never calls
 * mergeUsers for a Tier E result.
 */

import { test, expect, describe, mock } from "bun:test";
import { runDedup, type DedupDeps } from "@/services/dedup";
import type { DedupCandidate } from "@/db/dedup";
import type { MergeCandidateUser } from "@/identity/merge";

function user(id: string, overrides: Partial<MergeCandidateUser> = {}): MergeCandidateUser {
  return { id, createdAt: new Date("2024-01-01"), salesforceContactId: null, ...overrides };
}

function deps(overrides: Partial<DedupDeps> = {}): DedupDeps {
  return {
    findCandidates: mock(async () => []),
    insertCandidate: mock(async (candidate: DedupCandidate) => ({
      id: "ddc_1",
      user_id_a: candidate.userIdA,
      user_id_b: candidate.userIdB,
      tier: candidate.tier,
      evidence: candidate.evidence,
      status: "pending" as const,
      decided_by: null,
      decided_at: null,
      created_at: new Date(),
    })),
    markDecided: mock(async () => {}),
    fetchUserForMerge: mock(async id => user(id)),
    mergeUsers: mock(async () => ({ merged: true })),
    actor: "dedup-job",
    ...overrides,
  };
}

const TIER_A: DedupCandidate = {
  userIdA: "usr_a",
  userIdB: "usr_b",
  tier: "A",
  evidence: { salesforceContactId: "sf_1" },
};

const TIER_E: DedupCandidate = {
  userIdA: "usr_c",
  userIdB: "usr_d",
  tier: "E",
  evidence: { nameA: "Ananya Rao", nameB: "Ananya Roa", similarity: 0.9 },
};

describe("runDedup", () => {
  test("auto-merges a Tier A candidate and marks it decided", async () => {
    const d = deps({ findCandidates: mock(async () => [TIER_A]) });
    const summary = await runDedup(d);

    expect(summary).toEqual({ foundByTier: { A: 1, B: 0, C: 0, D: 0, E: 0 }, autoMerged: 1, pending: 0 });
    expect(d.mergeUsers).toHaveBeenCalledTimes(1);
    expect(d.mergeUsers).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "A", evidence: TIER_A.evidence, actor: "dedup-job" }),
    );
    expect(d.markDecided).toHaveBeenCalledWith("ddc_1", "merged", "dedup-job");
  });

  test("never auto-merges a Tier E candidate — it stays pending", async () => {
    const d = deps({ findCandidates: mock(async () => [TIER_E]) });
    const summary = await runDedup(d);

    expect(summary).toEqual({ foundByTier: { A: 0, B: 0, C: 0, D: 0, E: 1 }, autoMerged: 0, pending: 1 });
    expect(d.mergeUsers).not.toHaveBeenCalled();
    expect(d.markDecided).not.toHaveBeenCalled();
  });

  test("picks the Salesforce-linked side as survivor when auto-merging", async () => {
    const linked = user("usr_a", { salesforceContactId: "sf_1" });
    const unlinked = user("usr_b", { createdAt: new Date("2020-01-01") }); // older, but not Salesforce-linked
    const d = deps({
      findCandidates: mock(async () => [TIER_A]),
      fetchUserForMerge: mock(async id => (id === "usr_a" ? linked : unlinked)),
    });
    await runDedup(d);

    expect(d.mergeUsers).toHaveBeenCalledWith(
      expect.objectContaining({ survivorId: "usr_a", loserId: "usr_b" }),
    );
  });

  test("is idempotent: a pair already queued or decided (insertCandidate returns null) is skipped entirely", async () => {
    const d = deps({
      findCandidates: mock(async () => [TIER_A]),
      insertCandidate: mock(async () => null),
    });
    const summary = await runDedup(d);

    expect(summary).toEqual({ foundByTier: { A: 1, B: 0, C: 0, D: 0, E: 0 }, autoMerged: 0, pending: 0 });
    expect(d.mergeUsers).not.toHaveBeenCalled();
    expect(d.fetchUserForMerge).not.toHaveBeenCalled();
  });

  test("mixed batch: auto-merges A, leaves E pending, counts both", async () => {
    const d = deps({ findCandidates: mock(async () => [TIER_A, TIER_E]) });
    const summary = await runDedup(d);

    expect(summary).toEqual({ foundByTier: { A: 1, B: 0, C: 0, D: 0, E: 1 }, autoMerged: 1, pending: 1 });
    expect(d.mergeUsers).toHaveBeenCalledTimes(1);
  });
});
