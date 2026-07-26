/**
 * `dedup_candidate` queries — the reviewed mapping table §8
 * (docs/architecture-plan.md) requires, plus the two candidate-finding queries
 * for tiers A (Salesforce contact id) and E (fuzzy name across sources with no
 * shared handle). All of OUR SQL lives here (AGENTS.md: only db/ writes SQL).
 *
 * Tiers B/C/D are not queried here (prompts/010 Assumption 5–6): B/C require an
 * identical verified email/phone across two DIFFERENT users, which
 * `uq_identity_value` (migration 0002) makes structurally impossible once
 * import has run — the second import already skips rather than duplicating.
 * D needs phone data no legacy source provides yet. `DedupCandidate`'s `tier`
 * union still names all five so the type doesn't need to change again once
 * that data exists.
 */

import { sql, type SQL } from "bun";
import { newId } from "@/db/types";
import type { DedupCandidateRow, DedupCandidateStatus, MergeTier } from "@/db/types";
import type { MergeCandidateUser } from "@/identity/merge";
import { nameSimilarity } from "@/identity/name-similarity";

/** ≥ this score is a Tier E match — same threshold §8 sets for phone+name
 * (there, phone already narrows the pool; here, name is the only signal, so
 * this stays the strict end of "fuzzy" on purpose). */
const NAME_SIMILARITY_THRESHOLD = 0.9;

export type DedupCandidate = {
  userIdA: string;
  userIdB: string;
  tier: MergeTier;
  evidence: Record<string, unknown>;
};

/** Consistent ordering so the same real-world pair always inserts as the same
 * row, regardless of which query found it — required for `uq_dedup_pair` to
 * actually make re-running the dedup pass idempotent. */
function orderedPair(idA: string, idB: string): [string, string] {
  return idA < idB ? [idA, idB] : [idB, idA];
}

/**
 * Tier A: same non-null `salesforce_contact_id` on two distinct, not-already-
 * merged users. Wired for when Salesforce contact ingestion exists (the column
 * is already there, from step 8) — finds nothing until then, harmlessly.
 */
export async function findTierACandidates(client: SQL = sql): Promise<DedupCandidate[]> {
  const rows = (await client`
    SELECT a.id AS user_id_a, b.id AS user_id_b, a.salesforce_contact_id AS salesforce_contact_id
    FROM "user" a
    JOIN "user" b
      ON a.salesforce_contact_id = b.salesforce_contact_id
     AND a.id < b.id
    WHERE a.salesforce_contact_id IS NOT NULL
      AND a.status <> 'merged'
      AND b.status <> 'merged'
  `) as { user_id_a: string; user_id_b: string; salesforce_contact_id: string }[];

  return rows.map(row => ({
    userIdA: row.user_id_a,
    userIdB: row.user_id_b,
    tier: "A" as const,
    evidence: { salesforceContactId: row.salesforce_contact_id },
  }));
}

type NameCandidate = { id: string; name: string; blockKey: string; sources: string[] };

/**
 * Every not-already-merged user with a name, tagged with which
 * `user_identity.source`s they hold and a cheap blocking key (first 3
 * characters of the normalised name) so the O(n^2) fuzzy comparison below only
 * ever runs within a bucket, never across the full user base.
 */
async function fetchNameCandidates(client: SQL): Promise<NameCandidate[]> {
  const rows = (await client`
    SELECT u.id AS id, u.name AS name, array_agg(DISTINCT ui.source) AS sources
    FROM "user" u
    JOIN user_identity ui ON ui.user_id = u.id
    WHERE u.status <> 'merged' AND u.name IS NOT NULL AND btrim(u.name) <> ''
    GROUP BY u.id, u.name
  `) as { id: string; name: string; sources: string[] }[];

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    sources: row.sources,
    blockKey: row.name.trim().toLowerCase().slice(0, 3),
  }));
}

function sourcesDisjoint(a: string[], b: string[]): boolean {
  return !a.some(source => b.includes(source));
}

/**
 * Tier E: same real person under two different products' handles — the case
 * §8 calls "the actual hard part". Weaker evidence than the doc's original
 * "same name + same institution" (institution/course data is out of scope for
 * Miles Identity per AGENTS.md — prompts/010 Assumption 7), so this always
 * lands in the manual review queue, never auto-merged.
 */
export async function findTierECandidates(client: SQL = sql): Promise<DedupCandidate[]> {
  const candidates = await fetchNameCandidates(client);

  const buckets = new Map<string, NameCandidate[]>();
  for (const candidate of candidates) {
    const bucket = buckets.get(candidate.blockKey);
    if (bucket) bucket.push(candidate);
    else buckets.set(candidate.blockKey, [candidate]);
  }

  const results: DedupCandidate[] = [];
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        if (!sourcesDisjoint(a.sources, b.sources)) continue;

        const similarity = nameSimilarity(a.name, b.name);
        if (similarity < NAME_SIMILARITY_THRESHOLD) continue;

        const [userIdA, userIdB] = orderedPair(a.id, b.id);
        results.push({
          userIdA,
          userIdB,
          tier: "E",
          evidence: { nameA: a.name, nameB: b.name, similarity },
        });
      }
    }
  }
  return results;
}

/** Runs every wired tier and returns the combined, ordered candidate list. */
export async function findDedupCandidates(client: SQL = sql): Promise<DedupCandidate[]> {
  const [tierA, tierE] = await Promise.all([findTierACandidates(client), findTierECandidates(client)]);
  return [...tierA, ...tierE];
}

/**
 * `ON CONFLICT DO NOTHING` on `uq_dedup_pair` — idempotent re-runs
 * (.agents/skills/postgres-migrations.md: batch jobs must be idempotent).
 * Returns `null` when the pair was already queued or decided.
 */
export async function insertDedupCandidate(candidate: DedupCandidate, client: SQL = sql): Promise<DedupCandidateRow | null> {
  const [userIdA, userIdB] = orderedPair(candidate.userIdA, candidate.userIdB);
  const rows = (await client`
    INSERT INTO dedup_candidate (id, user_id_a, user_id_b, tier, evidence, status)
    VALUES (${newId("dedup")}, ${userIdA}, ${userIdB}, ${candidate.tier}, ${JSON.stringify(candidate.evidence)}, 'pending')
    ON CONFLICT (user_id_a, user_id_b) DO NOTHING
    RETURNING *
  `) as DedupCandidateRow[];
  return rows[0] ?? null;
}

/** The manual review queue's read: every pending row, optionally scoped to one tier. */
export async function listPendingDedupCandidates(tier?: MergeTier, client: SQL = sql): Promise<DedupCandidateRow[]> {
  return (
    tier === undefined
      ? ((await client`
          SELECT * FROM dedup_candidate WHERE status = 'pending' ORDER BY created_at
        `) as DedupCandidateRow[])
      : ((await client`
          SELECT * FROM dedup_candidate WHERE status = 'pending' AND tier = ${tier} ORDER BY created_at
        `) as DedupCandidateRow[])
  );
}

/** Read for `identity/merge.ts`'s `pickSurvivor` (step 1) — the fields it needs
 * to decide which of two candidate users survives a merge. Reading Better
 * Auth's own `"user"` table via `Bun.sql` mirrors the existing precedent in
 * `src/db/access.ts`'s `userExists` (a read, not a migration — the "never
 * hand-edit a Better Auth table" rule is about schema, not this). */
export async function fetchMergeCandidateUser(userId: string, client: SQL = sql): Promise<MergeCandidateUser | null> {
  const rows = (await client`
    SELECT id, created_at, salesforce_contact_id FROM "user" WHERE id = ${userId}
  `) as { id: string; created_at: Date; salesforce_contact_id: string | null }[];
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, createdAt: row.created_at, salesforceContactId: row.salesforce_contact_id };
}

/** Marks a candidate decided — `merged` right after the auto-merge pass acts on
 * it, or `rejected`/`merged` once a human works the D/E queue (out of scope for
 * this task — see prompts/010's "Out of scope"). */
export async function markDedupCandidateDecided(
  id: string,
  status: Exclude<DedupCandidateStatus, "pending">,
  decidedBy: string,
  client: SQL = sql,
): Promise<void> {
  await client`
    UPDATE dedup_candidate SET status = ${status}, decided_by = ${decidedBy}, decided_at = now() WHERE id = ${id}
  `;
}
