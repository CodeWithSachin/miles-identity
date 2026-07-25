# Skill: openfga-authz

`@openfga/sdk` `0.9.6`. Read before touching anything in `src/authz/` or any permission decision.

---

## Three layers, each doing one job

```
Layer 1 · RBAC     coarse, from the token claim: "may this user open Masterclass at all?"
                   source: user_product_access. ~80% of checks. Zero cost.
        ▼
Layer 2 · GRAPH    resource-level, per request: "may they view course 42?"
                   "which courses may they view?"  → OpenFGA
        ▼
Layer 3 · ABAC     conditions ON graph edges: "…and is the enrolment still valid?"
```

**There is no separate policy engine.** Layer 3 is OpenFGA Conditions. Do not add casbin, OPA, or a rules engine.

## Why graph and not RBAC or ABAC alone

- **RBAC alone breaks** the moment permission depends on *which* course — you would need a role per course. Role explosion at 200K learners.
- **ABAC alone cannot enumerate.** Policy engines answer one question at a time and have no reverse index, so they cannot efficiently answer *"list every course this user can see"* — which is the LMS home screen and the Masterclass library. This is the decisive reason.

## The model

```dsl
model
  schema 1.1

type user

type vendor
  relations
    define admin: [user]
    define staff: [user] or admin

type package
  relations
    define subscriber: [user with active_subscription]

type cohort
  relations
    define member: [user with active_enrolment]

type course
  relations
    define owning_vendor: [vendor]
    define in_package:    [package]
    define in_cohort:     [cohort]
    define viewer: [user with active_enrolment]     # direct / promo / admin override
                   or subscriber from in_package    # package path
                   or member from in_cohort         # batch path
                   or staff from owning_vendor      # vendor path
    define editor: admin from owning_vendor

condition active_enrolment(current_time: timestamp, valid_from: timestamp, valid_until: timestamp) {
  current_time >= valid_from && current_time < valid_until
}

condition active_subscription(current_time: timestamp, expires_at: timestamp) {
  current_time < expires_at
}
```

That single `viewer` definition is the entire mixed-entitlement requirement: direct grant **or** package **or** cohort **or** vendor ownership, each time-bounded. Vendor isolation and vendor-admin delegation fall out of the same lines.

Chapter-level granularity, when needed, is `type chapter` with `parent: [course]` and `define viewer: viewer from parent`. One addition, no re-architecture.

## Conditions honour `ListObjects`

This is the property the design depends on:

```ts
await fga.listObjects({
  user: "user:usr_9988",
  relation: "viewer",
  type: "course",
  context: { current_time: new Date().toISOString() },
});
// expired enrolments simply are not in the result
```

An expired enrolment drops out of the catalogue automatically. No filtering pass in application code.

Condition context limits: 32KB persisted per tuple, CEL evaluation cost capped at 100. Keep conditions to time and simple comparisons — a condition that needs a subquery is a modelling mistake.

## Operating rules

### 1. Never put fine-grained permissions in the JWT

Coarse roles only. Course lists in a token bloat it and go stale within the token window. Resource decisions are made at request time.

### 2. The graph is never on the login path

Miles Identity must not call OpenFGA during authentication. Authorization is per-resource-request. Keeping them separate means an authz outage does not become a login outage.

### 3. Tuple sync via transactional outbox — never dual write

The single most common failure mode in Zanzibar-style deployments.

```ts
// CORRECT — one transaction
await sql.begin(async tx => {
  await tx`INSERT INTO enrolment (...) VALUES (...)`;
  await tx`INSERT INTO outbox (aggregate, event_type, payload)
           VALUES ('enrolment', 'created', ${payload})`;
});
// a worker drains outbox → fga.write(...) → marks processed_at
```

```ts
// WRONG — drifts the first time the second call fails
await sql`INSERT INTO enrolment ...`;
await fga.write({ writes: [tuple] });
```

Plus a `Bun.cron` reconciliation job that diffs product data against tuples and reports orphans. Drift is not hypothetical; assume it and detect it.

### 4. `ListObjects` for pages, never N × `Check`

A catalogue page doing 200 individual `check` calls will be slow and will hammer the service. Fetch the permitted set once, then filter locally.

### 5. One store, typed objects — not one store per product

Vendor → course → learner traversal crosses product boundaries. Namespace inside a single model.

### 6. Deny by default

No tuple, no access. Never a fallback that grants on error — if OpenFGA is unreachable, the answer is deny plus an alert, never allow.

### 7. Model tests in CI

Negative cases are the point:

- vendor A's staff **cannot** read vendor B's course
- an expired enrolment **cannot** read the course
- a vendor admin **cannot** grant themselves LMS access
- a cohort member loses access when the cohort membership expires

### 8. Shadow mode before enforcement — mandatory

When the graph first goes live: graph decides, **RBAC still enforces**, disagreements logged and reviewed. Flip enforcement only after the disagreement rate is zero for a week.

Flipping an unvalidated model is how you lock 200K learners out of content they have paid for.

## Engine choice, for the record

OpenFGA over SpiceDB and Permify because of first-party **Node and Python** SDKs — the LMS is Node and both other backends are Django, so one model serves all three with no hand-rolled client. CNCF, Apache-2.

Managed (Okta FGA) vs self-hosted is an open decision. Self-hosting adds another stateful service to operate on top of Miles Identity itself.
