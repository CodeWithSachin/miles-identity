# 007 — Dev OTP flag + Scalar API documentation

> Approved plan. See `prompts/PROMPT.md` step 7.

---

## Goal

Add a config-gated Dev OTP bypass that is unrepresentable in production, and document the routes we own with a Scalar reference built from the same zod schemas that validate them.

## What it read

- Skills: `.agents/skills/scalar-api-docs.md`, `.agents/skills/security.md`, `.agents/skills/better-auth.md`
- Files opened: `src/auth.ts`, `src/lib/config.ts`, `src/services/otp.ts`, `src/services/otp-signin.ts`, `src/auth/alias-otp.ts`, `src/routes/identity.ts`, `src/identity/resolve.ts`, `src/routes/health.ts`, `src/services/health.ts`, `src/integrations/email.ts`, `src/integrations/sms.ts`, `src/index.ts`, `AGENTS.md`, `prompts/PROMPT.md`, `prompts/TEMPLATE.md`, `tests/auth/instance.test.ts`, `tests/services/otp-signin.test.ts`, `tests/lib/config.test.ts`, `tests/routes/identity.test.ts`
- Confirmed no Scalar/OpenAPI package is needed: `zod@4.4.3` already has `z.toJSONSchema()`; no `openAPI()` plugin registered yet in `src/auth.ts`.

## Assumptions

- Flag name `DEV_OTP_BYPASS` (tier-2 boolean env var). When true, sign-in OTP uses a fixed code (`DEV_OTP_CODE = "000000"`) and the email/SMS sender is never called — so a dev box needs no SMS/email provider keys.
- Enforcement: a schema-level cross-field `.refine()` on the composed config schema (the first cross-field refine in `config.ts`) rejects `DEV_OTP_BYPASS=true` when `NODE_ENV=production`.
- Scalar spec covers only routes we own today: `/api/identity/resolve`, `/health`, `/ready`. `/api/auth/*` (including alias-otp's own endpoints) is covered by Better Auth's `openAPI()` plugin automatically.
- Production posture: not mounted at all when `NODE_ENV=production` (the skill's "simplest, recommended" option) — both our own `/api/docs*` routes and Better Auth's `disableDefaultReference`.

## Files that will change

| File | Create / Modify | What changes |
|---|---|---|
| `src/lib/config.ts` | modify | tier-2 `DEV_OTP_BYPASS` (enum-parsed boolean, default false); cross-field `.refine()` forbidding it under `NODE_ENV=production` |
| `src/services/otp.ts` | modify | export `DEV_OTP_CODE = "000000"` |
| `src/services/otp-signin.ts` | modify | `StartDeps.devOtp?: string`; skip sender + use fixed code when set; new outcome `"dev_bypass"` |
| `src/auth/alias-otp.ts` | modify | `AliasOtpOptions.devOtp?: string`, threaded into `startOtpSignin` |
| `src/auth.ts` | modify | wire `devOtp` from config into `aliasOtp(...)`; add `openAPI()` plugin |
| `src/routes/identity.ts` | modify | export `bodySchema`; add + export `responseSchema`; validate response through it |
| `src/routes/docs.ts` | create | `buildOpenApiSpec()`, `openApiSpec()`, `scalarPage`, `docsRoutes(nodeEnv)` |
| `src/index.ts` | modify | spread `docsRoutes(config.NODE_ENV)` into `Bun.serve({ routes })` |
| `tests/lib/config.test.ts` | modify | `DEV_OTP_BYPASS` parse + cross-field rejection tests |
| `tests/services/otp-signin.test.ts` | modify | `devOtp` bypass test |
| `tests/auth/instance.test.ts` | modify | `openAPI` plugin wiring + alias-otp `devOtp` wiring tests |
| `tests/routes/docs.test.ts` | create | spec content + production-gating tests |

## Implementation requirements

1. `config.ts`: `DEV_OTP_BYPASS: z.enum(["true", "false"]).transform((v) => v === "true").default(false)` in `tier2` — `.default()` must come AFTER `.transform()`, not before: with `zod`'s `.partial()` (used to build tier 2), a `.default()` placed before a `.transform()` is stripped for an absent key, so the field is silently missing rather than `false`. Schema-level `.refine((data) => !(data.DEV_OTP_BYPASS && data.NODE_ENV === "production"), { message: ..., path: ["DEV_OTP_BYPASS"] })`.
2. `otp-signin.ts`: `const otp = deps.devOtp ?? generateOtp();`, store hash as today, then if `deps.devOtp` was set, return `"dev_bypass"` without calling `deps.senders`.
3. `alias-otp.ts`: `AliasOtpOptions.devOtp?: string` passed straight through to `startOtpSignin`.
4. `auth.ts`: `aliasOtp({ sendEmailOtp, sendSmsOtp, devOtp: config.DEV_OTP_BYPASS ? DEV_OTP_CODE : undefined })`; add `openAPI({ disableDefaultReference: config.NODE_ENV === "production" })`.
5. `identity.ts`: export `bodySchema`; add `export const responseSchema = z.object({ methods: z.array(z.enum(["email_otp", "sms_otp", "password"])) })`; `Response.json(responseSchema.parse(resolveHandle(parsed)), { headers: NO_STORE })`.
6. `routes/docs.ts`: `buildOpenApiSpec()` (OpenAPI 3.1.1, paths for `GET /health`, `GET /ready`, `POST /api/identity/resolve` built from `z.toJSONSchema`); `openApiSpec(spec)` helper; `scalarPage` static Response; `docsRoutes(nodeEnv)` pure function returning `{}` in production else both docs routes.
7. `index.ts`: spread `docsRoutes(config.NODE_ENV)` into the route map.

## Data model impact

None.

## Security requirements

- Dev OTP bypass never reaches the network (senders skipped entirely).
- `DEV_OTP_BYPASS=true` + `NODE_ENV=production` fails config validation — process exits before binding a port. This is the mechanism making a fixed OTP unrepresentable in production (AGENTS.md rule 14).
- The fixed code is a public dev-only constant, never logged (log lines stay generic — `outcome` only).
- Scalar reference and both spec endpoints absent entirely in production (rule 13).
- Resolve endpoint's spec documents exactly one response shape — no hit/miss distinction.
- No `/api/internal/*` routes exist yet; a test guards zero occurrences in the spec.

## Authorization impact

None.

## API documentation impact

- Routes documented: `GET /health`, `GET /ready`, `POST /api/identity/resolve` (pre-existing, newly documented).
- Schemas: `bodySchema` / `responseSchema` in `src/routes/identity.ts`, the same objects used at runtime.
- Auth requirement: all three unauthenticated.
- Public / admin / internal: all public; nothing internal exists yet.
- Error responses: `400` invalid body, `429` rate limited, one `200` shape — no distinct "not found".
- `/api/auth/*` covered by Better Auth's `openAPI()` plugin, not hand-written.

## Bun-native check

No new dependencies: `z.toJSONSchema()` is native to installed `zod@4.4.3`; Scalar UI loads via CDN script; `openAPI()` ships inside installed `better-auth@1.6.25`.

## Acceptance criteria

- [ ] `DEV_OTP_BYPASS=true` makes sign-in OTP always `"000000"`, no sender call.
- [ ] `DEV_OTP_BYPASS=true` + `NODE_ENV=production` fails config validation, process exits before binding a port.
- [ ] `/api/docs` and `/api/docs/openapi.json` serve outside production, absent in production.
- [ ] `/api/auth/reference` follows the same gating via `disableDefaultReference`.
- [ ] Scalar reference renders and shows all documented routes.
- [ ] `bun run check` passes.

## Tests to add

- [ ] `tests/lib/config.test.ts` — `DEV_OTP_BYPASS` default/parse; rejected with `NODE_ENV=production`; allowed under development/test.
- [ ] `tests/services/otp-signin.test.ts` — `devOtp` set → `"dev_bypass"`, senders never called, fixed code verifies.
- [ ] `tests/auth/instance.test.ts` — `openAPI` plugin registered with `disableDefaultReference` tied to `NODE_ENV`; alias-otp `devOtp` wiring.
- [ ] `tests/routes/docs.test.ts` — spec content, zero `/api/internal` occurrences, one response shape for resolve, `docsRoutes("production")` empty.

## Checks to run

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun audit`
- [ ] the changed routes appear correctly in the Scalar reference

## How to verify it

```bash
1. bun run check
   → typecheck, tests, and audit all pass
2. bun run dev
   curl -s localhost:3000/api/docs/openapi.json | jq '.paths | keys'
   → ["/api/identity/resolve", "/health", "/ready"]
3. curl -s localhost:3000/api/docs/openapi.json | grep -c '/api/internal'
   → 0
4. curl -s localhost:3000/api/auth/open-api/generate-schema | jq '.info.title'
5. open http://localhost:3000/api/docs
6. DEV_OTP_BYPASS=true bun run dev — sign in, confirm the OTP is always 000000, no gateway call
7. DEV_OTP_BYPASS=true NODE_ENV=production bun src/index.ts → exits 1, error names DEV_OTP_BYPASS
8. NODE_ENV=production bun src/index.ts &
   curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/docs                          # → 404
   curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/auth/reference                 # → 404
   curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/auth/open-api/generate-schema  # → 404
```

Note: `disableDefaultReference` only gates the HTML reference page, not the plugin's raw
`/open-api/generate-schema` route — that third curl check needed `disabledPaths` to also
list `/open-api/generate-schema` in production (added to `src/auth.ts`, not in the original
plan text but required by rule 13: the spec itself must be unreachable, not only the UI).

## Out of scope for this task

- RBAC / role claims (step 8).
- `/api/internal/*` or `/api/admin/*` — don't exist yet.
- Admin-gated docs access — production posture here is "not mounted at all."
- Changing `generateOtp()`'s real randomness — the bypass is additive.
