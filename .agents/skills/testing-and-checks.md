# Skill: testing-and-checks

`bun test` only. Read before writing tests or reporting a task done.

---

## The runner

Jest-compatible, TypeScript native, zero config. No Jest, Vitest, Mocha, ts-node, sinon.

```ts
import { test, expect, describe, mock, spyOn, beforeEach, afterEach } from "bun:test";
```

```bash
bun test                    # all
bun test --watch            # while developing
bun test --coverage         # thresholds in bunfig.toml
bun test src/identity       # one directory
bun test -t "cannot log in" # by name
```

`tests/` mirrors `src/`. Coverage floor is 80% line and function — enforced, not aspirational.

## What must be tested

Not "the happy path works". These specifically:

### Negative tests — the point of the suite

| Assertion |
|---|
| An **unverified** identity cannot authenticate |
| An **unverified** identity cannot receive a sign-in OTP |
| Vendor A's staff cannot read vendor B's course |
| A vendor admin cannot grant themselves LMS access |
| An expired enrolment cannot read the course |
| A non-admin cannot call `/api/admin/*` |
| `/api/internal/*` rejects an unsigned request |
| A rotated refresh token cannot be reused |
| A revoked session cannot refresh |
| A federated login does not auto-link to an existing password account |

### Invariants

| Assertion |
|---|
| `UNIQUE (type, value)` holds — a handle never points at two users |
| Exactly one `is_primary` per (user, type) |
| `normalise(normalise(x)) === normalise(x)` |
| After a merge, the merged id resolves to the survivor |
| After a merge, both users' sessions and refresh tokens are gone |
| `resolve` returns identical shape for hit and miss |
| Alias-link OTP goes to the existing verified handle |
| Domain write and outbox row commit together, or neither commits |

If a plan touches any of these areas and does not add the matching test, the plan is incomplete.

## Style

- Test **behaviour through the service layer**, not implementation details. Services take and return plain data specifically so they are testable without HTTP.
- Real Postgres for anything touching SQL. A mocked database does not enforce a unique constraint, and the constraint is the thing under test. Use a disposable schema per run.
- Mock only true externals: SMS gateway, email provider, Salesforce, OpenFGA HTTP.
- One assertion concept per test. `test("unverified identity cannot log in")` — the name states the guarantee.
- No snapshot tests for auth responses. A snapshot passes happily when a token leaks into the payload.
- Never weaken an assertion to make a test pass. If a test fails, either the code is wrong or the expectation was wrong — decide which, in writing.

## Testing `Bun.cron`

In-process cron is anchored to the real wall clock. `setSystemTime`, `useFakeTimers`, and `advanceTimersByTime` **do not** move it.

Test the handler function directly:

```ts
// WRONG — will never fire under test
Bun.cron("*/15 * * * *", reconcileTuples);

// RIGHT — schedule in jobs/, logic in services/, test the logic
await reconcileTuples();
expect(orphans).toBe(0);
```

Use `Bun.cron.parse()` if you need to assert a schedule is what you think it is.

## The checks

```bash
bun run typecheck   # tsc --noEmit, strict, no any
bun test            # with coverage thresholds
bun audit           # dependency advisories
bun run check       # all three
```

**A task is not done until all three pass.** Do not report success with a failing check and an intention to fix it. Do not disable a rule, lower a threshold, or skip a test to get green — if that seems necessary, stop and say so.

## Reporting verification

Exact commands and expected output. Never "it should work".

```
Verify:
1. bun run check                        → 3 suites pass, coverage 84% line
2. bun --hot src/index.ts
3. curl -s localhost:3000/ready         → {"status":"ok","postgres":true,"redis":true}
4. curl -s -X POST localhost:3000/api/identity/resolve \
     -H 'content-type: application/json' -d '{"handle":"known@example.com"}'
   → 200, {"methods":["password","email_otp"]}
5. same call with unknown@example.com
   → 200, identical shape, no user disclosure   ← the security property
```

Step 5 is the pattern to copy: verify the **security property**, not just that the endpoint returns 200.
