# NNN — <feature name>

> Copy this file to `prompts/NNN-<slug>.md`. Every section filled before asking for approval.
> A thin or missing section is a reason to push back, not a reason to proceed.

---

## Goal

One sentence. What this task accomplishes.

_If it cannot be said in one sentence, the task is not understood yet and the plan will wander. Stop and split it._

## What it read

- Skills: `.agents/skills/…`
- Files actually opened: `src/…`, `src/…`
- Docs consulted, with the specific fact taken from each

_This is the proof the plan is grounded in real code rather than assumptions. "AGENTS.md" alone is not sufficient._

## Assumptions

Anything ambiguous that was resolved independently, stated explicitly.

_The most valuable section. This is where a wrong guess gets caught before it becomes wrong code. If there are genuinely none, say "none" — do not leave it blank._

## Files that will change

| File | Create / Modify | What changes |
|---|---|---|
| `src/…` | create | … |
| `src/…` | modify | … |

_Exact list, before anything is touched. A file not on this list must not be edited._

## Implementation requirements

Concrete behaviour, numbered. Not a vague summary.

1. …
2. …

_"Handle the alias lookup" is not a requirement. "Query `user_identity` on (type, value) filtered to `is_verified = true`, return the `user_id` or null" is._

## Data model impact

- New or changed tables, columns, constraints, indexes
- Migration file number and name
- Save rules enforced, and whether in schema, writer, or both
- `None` if nothing changes

## Security requirements

Restated for **this** task, not a pointer to the skill file.

- What must stay server-side
- Which secrets are touched
- Which of the four takeover paths this code could open
- Rate limiting, enumeration, and authorization checks that apply here

## Authorization impact

- Layer 1 (RBAC) changes
- Layer 2 (graph) model or tuple changes, and the outbox events that produce them
- Layer 3 (conditions) changes
- `None` if nothing changes

## API documentation impact

Required whenever an endpoint is added, changed or removed. See `.agents/skills/scalar-api-docs.md`.

- Routes added / changed / removed
- The zod schemas the spec derives from (request and response) — one definition, not a parallel one
- Auth requirement per route, and the security scheme it maps to
- Public / admin-only / internal-and-undocumented
- Error responses, described honestly — including any deliberately indistinct ones
- `None` if no endpoint changed

## Bun-native check

Confirm no dependency was added for something Bun provides. If a new dependency **is** proposed, name it, name what it does, and justify it against the stack table in AGENTS.md.

- New dependencies: `none` / `<pkg>@<version>` because …

## Acceptance criteria

What "done" means, written so it can be ticked off rather than guessed.

- [ ] …
- [ ] …

## Tests to add

Named tests, including the **negative** cases. See `.agents/skills/testing-and-checks.md`.

- [ ] `…` — asserts …
- [ ] `…` — asserts the failure case …

## Checks to run

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun audit`
- [ ] `bun run db:migrate` on a staging clone _(if migrations changed)_
- [ ] the changed route appears correctly in the Scalar reference _(if endpoints changed)_

## How to verify it

Exact commands and expected output. Never "it should work".

```bash
1. bun run check
   → …
2. …
   → …
```

Include at least one step that verifies the **security property**, not just a 200 response.

## Out of scope for this task

What was deliberately not built, so it does not get built by accident.

- …
