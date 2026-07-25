# prompts/

Approved implementation plans, one per feature, numbered in build order.

## How this folder works

The AI writes a plan here **before** writing code. You review the plan, not the code. Once approved, the plan is the contract for that feature — and the record of why the code looks the way it does.

```
prompts/
  TEMPLATE.md              copy this
  001-config-skeleton.md
  002-database-data-model.md
  003-better-auth-core.md
  …
```

Numbers follow the roadmap in `AGENTS.md`. Never renumber an existing plan.

## The loop

1. You send a short prompt naming one feature and the skills it needs.
2. The AI reads `AGENTS.md` and those skills, inspects the real code, and writes `prompts/NNN-<slug>.md`.
3. **You review the plan.** Push back on anything thin — especially **Assumptions**, **Security requirements**, and the negative tests.
4. You approve.
5. The AI implements exactly what was approved.
6. The AI runs `bun run check` and reports exact verification steps.
7. You verify, then move to the next feature.

## Your everyday prompt

Short. The context already lives in `AGENTS.md` and the skills.

```
Implement the alias resolution endpoint.
Use @.agents/skills/alias-identity and @.agents/skills/postgres-migrations.
```

```
Implement the OAuth provider mount and JWKS.
Use @.agents/skills/better-auth and @.agents/skills/security.
```

Do **not** write "read AGENTS.md" — it loads automatically. Do not re-explain rules that already live there.

### Anti-patterns

| ❌ | Why it fails |
|---|---|
| "Build the whole auth service" | too much at once, no reviewable plan |
| "Make login better" | vague; nothing to accept or reject |
| Re-stating AGENTS.md rules in a 40-line prompt | the file exists so you never have to |
| "Just quickly add X while you're in there" | scope creep; X gets no plan and no tests |

One feature per prompt. Name the skills. Let the rules live in `AGENTS.md`.

## Reviewing a plan — what to actually look for

- **Assumptions** — the highest-value section. A wrong assumption here is wrong code later.
- **Security requirements** — restated for this task, not a pointer. Does it name which of the four takeover paths apply?
- **Tests to add** — are the **negative** cases there? "Unverified identity cannot log in" is not optional.
- **Files that will change** — anything surprising on the list? Anything missing?
- **Bun-native check** — did a package sneak in for something Bun already does?
- **How to verify it** — real commands, and at least one that checks a security property rather than a 200.

If a section is thin, say so and ask for a revision. That is cheaper than reviewing the code afterwards.
