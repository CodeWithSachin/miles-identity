/**
 * Row types and enum unions for the tables Miles Identity owns.
 *
 * The `const` arrays are the single source for both the TypeScript unions and the
 * CHECK constraint lists in `migrations/`. If you add a value here, add it to the
 * matching CHECK in a new migration — the database is the enforcement point, this
 * file is the convenience.
 */

export const IDENTITY_TYPES = ["email", "phone"] as const;
export type IdentityType = (typeof IDENTITY_TYPES)[number];

export const IDENTITY_SOURCES = ["lms", "miles_one", "masterclass", "salesforce", "self"] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

export const PRODUCT_IDS = ["lms", "miles_one", "masterclass"] as const;
export type ProductId = (typeof PRODUCT_IDS)[number];

export const ROLES = ["CPA", "CMA", "CAIRA", "ADMIN", "NORMAL", "VENDOR", "VENDOR_ADMIN"] as const;
export type Role = (typeof ROLES)[number];

/** Roles that must carry a vendor_id. Mirrors ck_access_vendor_scope. */
export const VENDOR_ROLES = ["VENDOR", "VENDOR_ADMIN"] as const;
export type VendorRole = (typeof VENDOR_ROLES)[number];

export const VENDOR_STATUSES = ["pending", "active", "disabled"] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

export const ACCESS_STATUSES = ["active", "revoked"] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

/** Dedup confidence tiers. A–C auto-merge; D and E require manual review. */
export const MERGE_TIERS = ["A", "B", "C", "D", "E"] as const;
export type MergeTier = (typeof MERGE_TIERS)[number];

export const USER_STATUSES = ["active", "invited", "suspended", "merged"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** A dedup candidate's review state. `pending` until a human (D/E) or the auto-merge
 * pass (A/B/C) decides it; `merged`/`rejected` are terminal. Mirrors ck_dedup_status. */
export const DEDUP_CANDIDATE_STATUSES = ["pending", "merged", "rejected"] as const;
export type DedupCandidateStatus = (typeof DEDUP_CANDIDATE_STATUSES)[number];

// ── rows ──────────────────────────────────────────────────────────────────────

export type SchemaMigrationRow = {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
};

export type UserIdentityRow = {
  id: string;
  user_id: string;
  type: IdentityType;
  value: string;
  is_primary: boolean;
  is_verified: boolean;
  source: IdentitySource;
  verified_at: Date | null;
  created_at: Date;
};

export type VendorRow = {
  id: string;
  name: string;
  sso_provider_id: string | null;
  allowed_email_domains: string[];
  domain_verified_at: Date | null;
  status: VendorStatus;
  created_at: Date;
  updated_at: Date;
};

export type UserProductAccessRow = {
  id: string;
  user_id: string;
  product_id: ProductId;
  role: Role;
  vendor_id: string | null;
  status: AccessStatus;
  granted_by: string | null;
  granted_at: Date;
  revoked_at: Date | null;
};

export type IdentityMergeLogRow = {
  id: string;
  survivor_user_id: string;
  merged_user_id: string;
  tier: MergeTier;
  evidence: unknown;
  actor: string;
  created_at: Date;
};

export type DedupCandidateRow = {
  id: string;
  user_id_a: string;
  user_id_b: string;
  tier: MergeTier;
  evidence: unknown;
  status: DedupCandidateStatus;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
};

export type OutboxRow = {
  id: bigint;
  aggregate: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  processed_at: Date | null;
};

// ── id prefixes ───────────────────────────────────────────────────────────────

/**
 * Prefixed, time-ordered ids. UUIDv7 rather than v4 for index locality on
 * insert-heavy tables. The `usr_` prefix is fixed by AGENTS.md.
 */
export const ID_PREFIX = {
  user: "usr_",
  identity: "idt_",
  vendor: "vnd_",
  access: "acc_",
  merge: "mrg_",
  dedup: "ddc_",
  // The `providerId` we hand to Better Auth's `sso` plugin when registering a
  // vendor's ssoProvider row (step 11) — a Miles Identity id, not a Better
  // Auth-owned one, so it gets our own prefix like everything else here.
  vendorSso: "ssp_",
} as const;

export function newId(kind: keyof typeof ID_PREFIX): string {
  return `${ID_PREFIX[kind]}${Bun.randomUUIDv7()}`;
}
